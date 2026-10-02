import { Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { avatarPartBoxes, createAvatarFigure } from '../src/three/avatar-figure.js';
import { JUMP_AIR_MS, JUMP_TOTAL_MS, jumpPose } from '../src/jump.js';
import { figurePoses, type Pose } from './avatar-clipping.js';

/**
 * An offline z-fighting check for the procedural avatars (D-059, D-109).
 *
 * Two faces that face the same way and lie on (nearly) the same plane, and
 * overlap, fight for the same depth-buffer pixels: as the figure or camera
 * moves, the nearer one flips from frame to frame and the overlap flickers.
 * A hair cap level with a goggle strap, a coat panel flush with the shirt
 * under it, an overlay plate with its face on the base box's face.
 *
 * Every face of every box (`avatarPartBoxes`) of every mesh is posed into
 * the figure's frame. A pair of faces from two different boxes is a finding
 * when their normals agree, the patch where they overlap lies within
 * `ZFIGHT_GAP` of both planes, the patch is bigger than `ZFIGHT_MIN_AREA`,
 * and no third box covers it (a buried overlap never reaches the screen).
 *
 * Boxes in one mesh keep their relative places in every pose, so that half of
 * the check runs once; pairs across meshes (head against torso, arm against
 * coat) are checked in every pose the clipping check uses plus the jump.
 */

/**
 * Faces nearer than this to each other's plane count as one plane. The
 * street camera (near plane 0.1, about 12.9 to the player) resolves about
 * 0.0001 of depth with a 24-bit buffer, and less on a large rooftop shot or
 * a mobile GPU's 16-bit buffer, so anything under 0.004 is at risk.
 */
export const ZFIGHT_GAP = 0.004;
/** An overlap smaller than this, in square units, is under a tenth of a street-camera pixel. */
export const ZFIGHT_MIN_AREA = 1e-5;
/** Normals within about 2 degrees face the same way. */
const SAME_FACING = Math.cos((2 * Math.PI) / 180);
/**
 * A face pointing within about 2 degrees of straight down is never drawn:
 * every camera in the game looks down at the figure (camera-rig.ts).
 */
const HORIZON_GRAZE = Math.sin((2 * Math.PI) / 180);
/**
 * A patch is covered when a third box holds the point just in front of it
 * (this far out along its normal) at least `COVER_DEPTH` deep: a box resting
 * on the patch or burying it. Nothing can be seen through that.
 */
const COVER_STEP = 0.003;
const COVER_DEPTH = 0.001;

export interface ZFightFinding {
  readonly key: AvatarSpriteKey;
  readonly pose: string;
  /** `mesh:tag#n`: the nth box of that mesh's geometry, so the builder call can be found. */
  readonly a: string;
  readonly b: string;
  /** The shared face's outward direction in the figure's frame, such as `+z`. */
  readonly face: string;
  /** Largest distance between the two planes over the overlap, world units. */
  readonly gap: number;
  /** Overlap area, square world units. */
  readonly area: number;
  readonly point: readonly [number, number, number];
}

interface Face {
  readonly box: number;
  /** Nine numbers: the triangle's world vertices. */
  readonly tri: Float64Array;
  readonly n: Vector3;
  readonly d: number;
  /** The face's vertex colour, as packed linear RGB bytes. */
  readonly color: number;
}

interface PosedBox {
  readonly mesh: string;
  readonly id: string;
  readonly faces: readonly Face[];
  /** nx, ny, nz, d per face: inside where n·p < d. */
  readonly planes: Float64Array;
  readonly min: Vector3;
  readonly max: Vector3;
}

const FIGURE_MESHES = new Set([
  'avatar-head',
  'avatar-eyes',
  'avatar-torso',
  'avatar-arm-left',
  'avatar-arm-right',
  'avatar-leg-left',
  'avatar-leg-right',
]);

function collectBoxes(root: Object3D): PosedBox[] {
  root.updateMatrixWorld(true);
  const boxes: PosedBox[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  root.traverse((object) => {
    if (!(object instanceof Mesh) || !FIGURE_MESHES.has(object.name) || !object.visible) return;
    const geometry = object.geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    const colors = geometry.getAttribute('color');
    avatarPartBoxes(geometry).forEach((record, index) => {
      const faces: Face[] = [];
      const planes: number[] = [];
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (let t = 0; t < record.count; t += 1) {
        const v = (record.first + t) * 3;
        a.fromBufferAttribute(position, v).applyMatrix4(object.matrixWorld);
        b.fromBufferAttribute(position, v + 1).applyMatrix4(object.matrixWorld);
        c.fromBufferAttribute(position, v + 2).applyMatrix4(object.matrixWorld);
        for (const p of [a, b, c]) {
          min.min(p);
          max.max(p);
        }
        const n = new Vector3().crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        if (n.lengthSq() < 1e-14) continue;
        n.normalize();
        const d = n.dot(a);
        planes.push(n.x, n.y, n.z, d);
        // Straight down: no camera at or above the horizon ever sees its front.
        if (n.y < 0 && Math.hypot(n.x, n.z) < HORIZON_GRAZE) continue;
        const color = colors
          ? (Math.round(colors.getX(v) * 255) << 16) | (Math.round(colors.getY(v) * 255) << 8) | Math.round(colors.getZ(v) * 255)
          : 0;
        faces.push({ box: boxes.length, tri: Float64Array.of(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z), n, d, color });
      }
      boxes.push({
        mesh: object.name,
        id: `${object.name}:${record.tag}#${index}`,
        faces,
        planes: Float64Array.from(planes),
        min,
        max,
      });
    });
  });
  return boxes;
}

function near(a: PosedBox, b: PosedBox, pad: number): boolean {
  return a.min.x <= b.max.x + pad && a.max.x + pad >= b.min.x &&
    a.min.y <= b.max.y + pad && a.max.y + pad >= b.min.y &&
    a.min.z <= b.max.z + pad && a.max.z + pad >= b.min.z;
}

type P2 = readonly [number, number];

/** Clip a convex polygon by the half-plane left of edge p→q (triangles are wound consistently in 2D below). */
function clipPolygon(polygon: P2[], p: P2, q: P2, sign: number): P2[] {
  const out: P2[] = [];
  const side = (r: P2): number => sign * ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  for (let i = 0; i < polygon.length; i += 1) {
    const cur = polygon[i]!;
    const prev = polygon[(i + polygon.length - 1) % polygon.length]!;
    const sc = side(cur);
    const sp = side(prev);
    if (sc >= 0) {
      if (sp < 0) out.push(cross(prev, cur, sp, sc));
      out.push(cur);
    } else if (sp >= 0) {
      out.push(cross(prev, cur, sp, sc));
    }
  }
  return out;
}

function cross(a: P2, b: P2, sa: number, sb: number): P2 {
  const t = sa / (sa - sb);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function area2(polygon: readonly P2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return sum / 2;
}

function dominantAxis(n: Vector3): string {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x >= 0 ? '+x' : '-x';
  if (ay >= az) return n.y >= 0 ? '+y' : '-y';
  return n.z >= 0 ? '+z' : '-z';
}

function covers(box: PosedBox, x: number, y: number, z: number): boolean {
  if (x < box.min.x || y < box.min.y || z < box.min.z || x > box.max.x || y > box.max.y || z > box.max.z) return false;
  const p = box.planes;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3]! - (p[i]! * x + p[i + 1]! * y + p[i + 2]! * z) < COVER_DEPTH) return false;
  }
  return true;
}

/** The overlap of two same-facing faces, if they would fight: area, gap and a point on it. */
function fight(f: Face, g: Face): { area: number; gap: number; samples: Array<[number, number, number]> } | null {
  // Same colour, same plane, same normal: either face draws the same pixels.
  if (f.color === g.color) return null;
  if (f.n.dot(g.n) < SAME_FACING) return null;
  if (Math.abs(f.d - g.d) > ZFIGHT_GAP * 2) return null;
  // A basis in f's plane.
  const n = f.n;
  const u = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const v = new Vector3().crossVectors(n, u);
  const project = (tri: Float64Array): P2[] => [0, 3, 6].map((o) => [
    tri[o]! * u.x + tri[o + 1]! * u.y + tri[o + 2]! * u.z,
    tri[o]! * v.x + tri[o + 1]! * v.y + tri[o + 2]! * v.z,
  ] as const);
  const pf = project(f.tri);
  const pg = project(g.tri);
  const af = area2(pf);
  const ag = area2(pg);
  if (Math.abs(af) < 1e-12 || Math.abs(ag) < 1e-12) return null;
  let polygon: P2[] = pf;
  const sign = Math.sign(ag);
  for (let i = 0; i < 3 && polygon.length > 0; i += 1) polygon = clipPolygon(polygon, pg[i]!, pg[(i + 1) % 3]!, sign);
  if (polygon.length < 3) return null;
  const area = Math.abs(area2(polygon));
  if (area < ZFIGHT_MIN_AREA) return null;
  // Lift the overlap back onto f's plane and measure how far g's plane is over it.
  const lifted = polygon.map(([s, t]): [number, number, number] => [
    u.x * s + v.x * t + n.x * f.d,
    u.y * s + v.y * t + n.y * f.d,
    u.z * s + v.z * t + n.z * f.d,
  ]);
  let gap = 0;
  const centre: [number, number, number] = [0, 0, 0];
  for (const p of lifted) {
    gap = Math.max(gap, Math.abs(g.n.x * p[0] + g.n.y * p[1] + g.n.z * p[2] - g.d));
    for (let i = 0; i < 3; i += 1) centre[i]! += p[i]! / lifted.length;
  }
  if (gap > ZFIGHT_GAP) return null;
  // The centre, then each corner drawn a fifth of the way in: where to ask whether the patch shows.
  const samples = [centre, ...lifted.map((p): [number, number, number] => [
    p[0] + (centre[0] - p[0]) * 0.2,
    p[1] + (centre[1] - p[1]) * 0.2,
    p[2] + (centre[2] - p[2]) * 0.2,
  ])];
  return { area, gap, samples };
}

/** Faces of box pairs that `pairs` picks, checked against each other. */
function fightsBetween(
  boxes: readonly PosedBox[],
  pairs: (a: PosedBox, b: PosedBox) => boolean,
  key: AvatarSpriteKey,
  pose: string,
): ZFightFinding[] {
  const worst = new Map<string, ZFightFinding>();
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j]!;
      if (!pairs(a, b) || !near(a, b, ZFIGHT_GAP)) continue;
      for (const f of a.faces) {
        for (const g of b.faces) {
          const hit = fight(f, g);
          if (!hit) continue;
          // Shown if any part of the patch has no third box over it.
          const shown = hit.samples.find(([x, y, z]) => {
            const ox = x + f.n.x * COVER_STEP;
            const oy = y + f.n.y * COVER_STEP;
            const oz = z + f.n.z * COVER_STEP;
            return !boxes.some((c) => c !== a && c !== b && covers(c, ox, oy, oz));
          });
          if (!shown) continue;
          const id = `${a.id}|${b.id}|${dominantAxis(f.n)}`;
          const previous = worst.get(id);
          const area = (previous?.area ?? 0) + hit.area;
          worst.set(id, {
            key,
            pose,
            a: a.id,
            b: b.id,
            face: dominantAxis(f.n),
            gap: Math.max(previous?.gap ?? 0, hit.gap),
            area,
            point: previous?.point ?? shown,
          });
        }
      }
    }
  }
  return [...worst.values()];
}

/** Every z-fight in a figure as it stands now. `key` and `pose` only label the findings. */
export function zFightsInFigure(root: Object3D, key: AvatarSpriteKey, pose: string): ZFightFinding[] {
  return fightsBetween(collectBoxes(root), () => true, key, pose);
}

/** The poses checked: the clipping check's rest, walk and sprint, plus a jump from take-off to landing. */
export function zFightPoses(): Pose[] {
  const poses = figurePoses();
  for (const ms of [0, JUMP_AIR_MS * 0.25, JUMP_AIR_MS * 0.5, JUMP_AIR_MS * 0.9, (JUMP_AIR_MS + JUMP_TOTAL_MS) / 2]) {
    const jump = jumpPose(ms);
    if (!jump) continue;
    poses.push({
      name: `jump ${Math.round(ms)}ms`,
      drive: (figure) => figure.update(16, { moving: false, sprinting: false, jump }),
    });
  }
  return poses;
}

/** Every z-fight in one look: within each mesh once, across meshes in every pose. */
export function findAvatarZFights(key: AvatarSpriteKey, poses: readonly Pose[] = zFightPoses()): ZFightFinding[] {
  const findings: ZFightFinding[] = [];
  poses.forEach((pose, index) => {
    const figure = createAvatarFigure(key);
    try {
      pose.drive(figure);
      const boxes = collectBoxes(figure.object);
      const pick = index === 0 ? () => true : (a: PosedBox, b: PosedBox) => a.mesh !== b.mesh;
      findings.push(...fightsBetween(boxes, pick, key, pose.name));
    } finally {
      figure.dispose();
    }
  });
  return summarizeZFights(findings);
}

/** One finding per pair of boxes and face direction, the largest overlap kept. */
export function summarizeZFights(findings: readonly ZFightFinding[]): ZFightFinding[] {
  const worst = new Map<string, ZFightFinding>();
  for (const finding of findings) {
    const id = `${finding.key}|${finding.a}|${finding.b}|${finding.face}`;
    const previous = worst.get(id);
    if (!previous || finding.area > previous.area) worst.set(id, finding);
  }
  return [...worst.values()].sort((x, y) => y.area - x.area);
}

export function formatZFight(finding: ZFightFinding): string {
  const at = finding.point.map((value) => value.toFixed(3)).join(', ');
  return `${finding.key}: ${finding.a} and ${finding.b} share a ${finding.face} face (gap ${finding.gap.toFixed(4)}, ` +
    `area ${finding.area.toExponential(1)} at (${at}) in ${finding.pose})`;
}
