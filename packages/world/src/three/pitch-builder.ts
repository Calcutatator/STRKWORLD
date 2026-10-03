import { Box3, BoxGeometry, Matrix4, Mesh, Quaternion, Vector3, type Group, type Material, type Object3D } from 'three';
import { FOOTBALL_POST_RADIUS, PITCH_AREA, PITCH_FIELD, PITCH_GOAL, type FootballSide } from '@strkworld/shared';
import {
  PITCH_CENTRE_SPOT,
  PITCH_FIXTURES,
  PITCH_GATE,
  PITCH_GATE_TEXT,
  PITCH_HALFWAY_X,
  PITCH_MIDDLE_Z,
  pitchScoreText,
  type PitchFixture,
} from '../map/pitch.js';
import type { DistrictMap } from '../map/street.js';
import { BLEACHER_PROFILE } from '../seats.js';
import {
  GeometryBin,
  PITCH_THEME,
  PLAZA_THEME,
  ResourceBag,
  beamGeometry,
  boxGeometry,
  createOpacityFader,
  cylinderGeometry,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  shade,
  standardMaterial,
  unlitMaterial,
  type Paint,
} from './palette.js';
import type { LabelFactory, Occluder, OccluderBounds, PitchView, TextLabel } from './types.js';

/**
 * The football pitch in 3D (D-078): a mown field with its white markings on
 * warm paving, low boards round the field, a white goal at each end, a
 * concrete stand along the north side seated in the two sides' colours with
 * the scoreboard over it, low bleachers along the south, a floodlight in each
 * corner, and a green steel fence with a gate where the road comes in.
 *
 * Presentation only, under the street's rule: every volume stands on a solid
 * `footing` or `railing` tile or outside the map; over walkable tiles there is
 * only turf, paint, paving, the boards (knee-low, below the height a volume
 * counts from) and what hangs above head height (the gate's lintel and sign).
 * Geometry is merged per material like the street's, one draw call per bin;
 * the gate's superstructure gets its own material so it fades like the
 * sandbox gate when it hides the player. The ball and the celebrations are
 * shared, moving state and live in football-view.ts.
 */

/** A pitch piece that fades when it hides the player: the gate's posts and lintel. */
export interface PitchOccluder extends Occluder {
  readonly kind: 'pitch';
  readonly part: 'gate';
  readonly object: Object3D;
}

/** Where the pitch hangs its parts: the street's own groups, lists and resources. */
export interface PitchParts {
  /** `street:ground`: the field, the paving and every volume. */
  readonly ground: Group;
  /** `street:labels`: the scoreboard and the gate sign. */
  readonly labels: Group;
  /** The street disposes these with its own signs. */
  readonly textLabels: TextLabel[];
  readonly animators: Array<(elapsedMs: number) => void>;
  readonly occluders: PitchOccluder[];
}

const GROUND = 'pitch-ground';
const DECOR = 'pitch-decor';
const GATE = 'pitch-gate';
const GLOW = 'pitch-glow';

/** The painted lines' width, inside the field's edges. */
export const PITCH_LINE_WIDTH = 0.08;
const LINE_Y = 0.012;
/** The boards round the field: below the 0.15 a walkable-tile volume counts from, like a kerb. */
export const PITCH_BOARD_HEIGHT = 0.13;
const BOARD_THICKNESS = 0.07;
/** The goal frame: crossbar height, the net's back, and the tubes. */
export const PITCH_GOAL_HEIGHT = 1.55;
const GOAL_BACK_HEIGHT = 1.1;
const POST_TUBE = 0.08;
const NET_STEP = 0.3;
const NET_STRAND = 0.018;
/** The street-side fence, its gate posts and the lintel over the gate. */
const FENCE_HEIGHT = 1.5;
const GATE_POST_TOP = 3.7;
const LINTEL_BOTTOM = 3.2;
const LINTEL_TOP = 3.55;
/** The scoreboard's centre height, over the stand's roof. */
export const PITCH_SCOREBOARD_Y = 4.3;
const STAND_TIER_RISE = 0.4;
const STAND_ROOF_Y = 3.3;

/**
 * Build the pitch into the street's groups. Returns null, adding nothing, on a
 * map without a field.
 */
export function buildPitch(map: DistrictMap, labels: LabelFactory, res: ResourceBag, parts: PitchParts): PitchView | null {
  if (!hasPitch(map)) return null;
  const fixtures = PITCH_FIXTURES.filter((piece) => standsOnFooting(map, piece));
  const bin = new GeometryBin();
  let gateMesh: Mesh | null = null;
  try {
    pave(map, bin);
    turf(bin);
    markings(bin);
    boards(bin);
    for (const piece of fixtures) {
      switch (piece.kind) {
        case 'goal':
          goal(piece.side ?? 'west', bin);
          break;
        case 'stand':
          stand(piece, bin);
          break;
        case 'bleacher':
          bleacher(piece, bin);
          break;
        case 'floodlight':
          floodlight(piece, bin);
          break;
      }
    }
    const hasGate = gatePosts(map) !== null;
    streetFence(map, bin);
    perimeterFence(map, bin);

    const groundMaterial = res.material(standardMaterial({ roughness: 0.95 }));
    const decorMaterial = res.material(standardMaterial({ roughness: 0.78 }));
    const gateMaterial = res.material(standardMaterial({ roughness: 0.6 }));
    const glowMaterial = res.material(unlitMaterial());
    flushBin(bin, GROUND, groundMaterial, res, parts.ground, { name: 'pitch:ground', receive: true });
    flushBin(bin, DECOR, decorMaterial, res, parts.ground, { name: 'pitch:decor', cast: true, receive: true });
    gateMesh = hasGate ? flushBin(bin, GATE, gateMaterial, res, parts.ground, { name: 'pitch:gate', cast: true, receive: true }) : null;
    flushBin(bin, GLOW, glowMaterial, res, parts.ground, { name: 'pitch:floodlights' });
    parts.animators.push((elapsed) => {
      // The floodlights hum, faintly and together.
      glowMaterial.color.setScalar(0.94 + 0.06 * Math.sin((elapsed / 1000) * 2.1));
    });
  } finally {
    bin.dispose();
  }

  const addLabel = (label: TextLabel, x: number, y: number, z: number, yaw = 0): TextLabel => {
    parts.textLabels.push(label);
    label.object.position.set(x, y, z);
    label.object.rotation.y = yaw;
    label.object.userData['area'] = 'pitch';
    parts.labels.add(label.object);
    return label;
  };

  // The scoreboard over the stand, facing the camera across the field.
  const standPiece = fixtures.find((piece) => piece.kind === 'stand') ?? null;
  const scoreboard = standPiece
    ? addLabel(labels.sign(pitchScoreText(0, 0), PITCH_THEME.scoreboard), PITCH_HALFWAY_X, PITCH_SCOREBOARD_Y, standPiece.y + 0.47)
    : null;
  if (scoreboard) scoreboard.object.userData['pitch'] = 'scoreboard';

  // The board over the gate, facing the street as you walk in (+X).
  const posts = gatePosts(map);
  let sign: TextLabel | null = null;
  if (posts) {
    sign = addLabel(
      labels.sign(PITCH_GATE_TEXT, PITCH_THEME.gate),
      PITCH_GATE.x + 0.7 + 0.02,
      (LINTEL_BOTTOM + LINTEL_TOP) / 2 + 0.12,
      (posts.north + posts.south + 1) / 2,
      Math.PI / 2,
    );
    sign.object.userData['pitch'] = 'gate';
  }

  if (gateMesh && posts) {
    const faded: Material[] = [...materialsOf(gateMesh), ...(sign ? materialsOf(sign.object) : [])];
    parts.occluders.push(gateOccluder(gateMesh, posts, faded));
  }

  let shown = { west: 0, east: 0 };
  return Object.freeze({
    setScore(west: number, east: number): void {
      const next = { west: wholeScore(west), east: wholeScore(east) };
      if (next.west === shown.west && next.east === shown.east) return;
      shown = next;
      scoreboard?.setText(pitchScoreText(next.west, next.east));
    },
  });
}

function wholeScore(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function hasPitch(map: DistrictMap): boolean {
  return map.tiles.some((row) => row.some((kind) => kind === 'turf'));
}

/** A fixture is built only where the map made its tiles solid pitch footing. */
function standsOnFooting(map: DistrictMap, piece: PitchFixture): boolean {
  for (let y = piece.y; y < piece.y + piece.height; y++) {
    for (let x = piece.x; x < piece.x + piece.width; x++) {
      if (map.tiles[y]?.[x] !== 'footing') return false;
    }
  }
  return true;
}

function materialsOf(root: Object3D): Material[] {
  const found: Material[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) found.push(material);
  });
  return found;
}

// ---------------------------------------------------------------------------
// The field and the paving
// ---------------------------------------------------------------------------

/**
 * Warm paving slabs on the walkway and under the goals and floodlights, a
 * darker edge where the walkway meets the field's boards. The stands and
 * bleachers cover their own footing.
 */
function pave(map: DistrictMap, bin: GeometryBin): void {
  const covered = new Set<string>();
  for (const piece of PITCH_FIXTURES) {
    if (piece.kind !== 'stand' && piece.kind !== 'bleacher') continue;
    for (let y = piece.y; y < piece.y + piece.height; y++) {
      for (let x = piece.x; x < piece.x + piece.width; x++) covered.add(`${x},${y}`);
    }
  }
  const { x: x0, y: y0, width, height } = PITCH_AREA;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const kind = map.tiles[y]?.[x];
      if (kind !== 'walkway' && kind !== 'footing') continue;
      if (covered.has(`${x},${y}`)) continue;
      bin.add(GROUND, flatQuad(x, y, x + 1, y + 1, 0), PITCH_THEME.walkwayEdge);
      const seed = hash01(x, y, 901);
      const tone = seed < 0.5 ? PITCH_THEME.walkway : PITCH_THEME.walkwayAlt;
      const g = 0.03;
      bin.add(GROUND, flatQuad(x + g, y + g, x + 1 - g, y + 1 - g, 0.004), jitterColor(tone, hash01(x, y, 902), 0.02));
    }
  }
}

/** The field: mown in stripes across its length, one every two tiles, as a broadcast pitch is. */
function turf(bin: GeometryBin): void {
  const { x: x0, y: y0, width, height } = PITCH_FIELD;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const stripe = Math.floor((x - x0) / 2) % 2 === 0;
      const tone = stripe ? PITCH_THEME.turf : PITCH_THEME.turfStripe;
      bin.add(GROUND, flatQuad(x, y, x + 1, y + 1, 0), jitterColor(tone, hash01(x, y, 911), 0.008));
    }
  }
}

/** A line's rectangle, painted flat on the turf. */
function stripe(bin: GeometryBin, x0: number, z0: number, x1: number, z1: number): void {
  bin.add(GROUND, flatQuad(x0, z0, x1, z1, LINE_Y), PITCH_THEME.line);
}

/** An arc of line from angle `a0` to `a1` (radians, 0 along +X, turning toward +Z). */
function arc(bin: GeometryBin, cx: number, cz: number, radius: number, a0: number, a1: number): void {
  const segments = Math.max(3, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * 40));
  const inner = radius - PITCH_LINE_WIDTH / 2;
  const outer = radius + PITCH_LINE_WIDTH / 2;
  for (let i = 0; i < segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    const b = a0 + ((a1 - a0) * (i + 1)) / segments;
    bin.add(
      GROUND,
      flatPolygon(
        [
          [cx + Math.cos(a) * inner, cz + Math.sin(a) * inner],
          [cx + Math.cos(a) * outer, cz + Math.sin(a) * outer],
          [cx + Math.cos(b) * outer, cz + Math.sin(b) * outer],
          [cx + Math.cos(b) * inner, cz + Math.sin(b) * inner],
        ],
        LINE_Y,
      ),
      PITCH_THEME.line,
    );
  }
}

function spot(bin: GeometryBin, cx: number, cz: number, radius: number): void {
  const points: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius]);
  }
  bin.add(GROUND, flatPolygon(points, LINE_Y), PITCH_THEME.line);
}

/** The penalty area's depth and width, the goal area's, and the penalty spot's distance, in tiles. */
export const PITCH_MARKINGS = Object.freeze({
  penaltyDepth: 3.6,
  penaltyWidth: 9,
  goalAreaDepth: 1.2,
  goalAreaWidth: 5.4,
  penaltySpot: 2.4,
  centreCircle: 2.2,
  corner: 0.5,
});

/**
 * Touchlines, goal lines and the halfway line, the centre circle and spot,
 * a penalty area, goal area, spot and arc at each end, and a quarter circle in
 * each corner. All paint, inside the field.
 */
function markings(bin: GeometryBin): void {
  const w = PITCH_LINE_WIDTH;
  const x0 = PITCH_FIELD.x;
  const x1 = PITCH_FIELD.x + PITCH_FIELD.width;
  const z0 = PITCH_FIELD.y;
  const z1 = PITCH_FIELD.y + PITCH_FIELD.height;
  const m = PITCH_MARKINGS;
  stripe(bin, x0, z0, x1, z0 + w);
  stripe(bin, x0, z1 - w, x1, z1);
  stripe(bin, x0, z0 + w, x0 + w, z1 - w);
  stripe(bin, x1 - w, z0 + w, x1, z1 - w);
  stripe(bin, PITCH_HALFWAY_X - w / 2, z0 + w, PITCH_HALFWAY_X + w / 2, z1 - w);
  arc(bin, PITCH_CENTRE_SPOT.x, PITCH_CENTRE_SPOT.z, m.centreCircle, 0, Math.PI * 2);
  spot(bin, PITCH_CENTRE_SPOT.x, PITCH_CENTRE_SPOT.z, 0.11);
  for (const side of [-1, 1] as const) {
    // From each goal line into the field.
    const line = side < 0 ? x0 : x1;
    const into = (depth: number): number => line - side * depth;
    const box = (depth: number, span: number): void => {
      const za = PITCH_MIDDLE_Z - span / 2;
      const zb = PITCH_MIDDLE_Z + span / 2;
      const inner = into(depth);
      const [xa, xb] = side < 0 ? [line + w, inner] : [inner, line - w];
      stripe(bin, xa, za, xb, za + w);
      stripe(bin, xa, zb - w, xb, zb);
      const edge = side < 0 ? inner - w : inner;
      stripe(bin, edge, za, edge + w, zb);
    };
    box(m.penaltyDepth, m.penaltyWidth);
    box(m.goalAreaDepth, m.goalAreaWidth);
    const spotX = into(m.penaltySpot);
    spot(bin, spotX, PITCH_MIDDLE_Z, 0.09);
    // The arc: the part of a circle round the spot that lies outside the penalty area.
    const reach = m.centreCircle - 0.3;
    const half = Math.acos(Math.min(1, (m.penaltyDepth - m.penaltySpot) / reach));
    const facing = side < 0 ? 0 : Math.PI;
    arc(bin, spotX, PITCH_MIDDLE_Z, reach, facing - half, facing + half);
  }
  // Corner arcs, a quarter circle into the field at each corner.
  const r = m.corner;
  arc(bin, x0, z0, r, 0, Math.PI / 2);
  arc(bin, x1, z0, r, Math.PI / 2, Math.PI);
  arc(bin, x1, z1, r, Math.PI, Math.PI * 1.5);
  arc(bin, x0, z1, r, Math.PI * 1.5, Math.PI * 2);
}

/**
 * Low boards round the field, just outside its lines, where the ball comes
 * back off: dark green with a white cap, knee-low, and open across each goal
 * mouth. They stand on the walkway, below the height a volume counts from, so
 * a player steps over them like a kerb.
 */
function boards(bin: GeometryBin): void {
  const x0 = PITCH_FIELD.x;
  const x1 = PITCH_FIELD.x + PITCH_FIELD.width;
  const z0 = PITCH_FIELD.y;
  const z1 = PITCH_FIELD.y + PITCH_FIELD.height;
  const t = BOARD_THICKNESS;
  const h = PITCH_BOARD_HEIGHT;
  const run = (xa: number, za: number, xb: number, zb: number): void => {
    bin.add(GROUND, boxGeometry(xa, 0, za, xb, h - 0.02, zb), PITCH_THEME.board);
    bin.add(GROUND, boxGeometry(xa, h - 0.02, za, xb, h, zb), PITCH_THEME.boardTop);
  };
  run(x0 - t, z0 - t, x1 + t, z0);
  run(x0 - t, z1, x1 + t, z1 + t);
  const mouthNorth = PITCH_MIDDLE_Z - PITCH_GOAL.width / 2 - FOOTBALL_POST_RADIUS;
  const mouthSouth = PITCH_MIDDLE_Z + PITCH_GOAL.width / 2 + FOOTBALL_POST_RADIUS;
  for (const [xa, xb] of [[x0 - t, x0], [x1, x1 + t]] as const) {
    run(xa, z0, xb, mouthNorth);
    run(xa, mouthSouth, xb, z1);
  }
}

// ---------------------------------------------------------------------------
// The goals
// ---------------------------------------------------------------------------

/**
 * A white goal on its footing behind the goal line: two posts just behind the
 * line, their faces on it, a crossbar, a lower frame at the back, and a net
 * strung on the back, both sides and the top. Seen side-on by the camera.
 */
function goal(side: FootballSide, bin: GeometryBin): void {
  const line = side === 'west' ? PITCH_FIELD.x : PITCH_FIELD.x + PITCH_FIELD.width;
  // `out` points away from the field, into the goal; `inward` back toward it.
  const out = side === 'west' ? -1 : 1;
  const inward = -out;
  const postX = line + out * FOOTBALL_POST_RADIUS;
  const backX = line + out * (PITCH_GOAL.depth - 0.06);
  const zN = PITCH_MIDDLE_Z - PITCH_GOAL.width / 2;
  const zS = PITCH_MIDDLE_Z + PITCH_GOAL.width / 2;
  const H = PITCH_GOAL_HEIGHT;
  const B = GOAL_BACK_HEIGHT;
  // Front frame.
  for (const z of [zN, zS]) bin.add(DECOR, cylinderGeometry(postX, 0, z, POST_TUBE, POST_TUBE, H + POST_TUBE, 10), PITCH_THEME.goal);
  bin.add(DECOR, beamGeometry([postX, H, zN], [postX, H, zS], POST_TUBE * 1.5, POST_TUBE * 1.5), PITCH_THEME.goal);
  // The back, and the stays down to it.
  const tube = 0.045;
  for (const z of [zN + 0.04, zS - 0.04]) {
    bin.add(DECOR, beamGeometry([backX, 0, z], [backX, B, z], tube), PITCH_THEME.goal);
    bin.add(DECOR, beamGeometry([postX, H, z], [backX, B, z], tube), PITCH_THEME.goal);
    bin.add(DECOR, beamGeometry([postX, 0.02, z], [backX, 0.02, z], tube), PITCH_THEME.goal);
  }
  bin.add(DECOR, beamGeometry([backX, B, zN], [backX, B, zS], tube), PITCH_THEME.goal);
  bin.add(DECOR, beamGeometry([backX, 0.02, zN], [backX, 0.02, zS], tube), PITCH_THEME.goal);
  // The net: strands on the back, the two sides and the sloping top.
  const strand = (a: [number, number, number], b: [number, number, number]): void => {
    bin.add(DECOR, beamGeometry(a, b, NET_STRAND), PITCH_THEME.net);
  };
  const netX = backX + inward * 0.03;
  for (let z = zN + NET_STEP; z < zS - 0.05; z += NET_STEP) strand([netX, 0.02, z], [netX, B, z]);
  for (let y = NET_STEP; y < B - 0.05; y += NET_STEP) strand([netX, y, zN], [netX, y, zS]);
  /** The sloping top's height over a point between the back and the posts. */
  const topAt = (x: number): number => B + ((H - B) * (x - backX)) / (postX - backX);
  const alongDepth = (from: number): number[] => {
    const xs: number[] = [];
    for (let x = from + inward * NET_STEP; inward * (postX - x) > 0.05; x += inward * NET_STEP) xs.push(x);
    return xs;
  };
  for (const z of [zN + 0.02, zS - 0.02]) {
    for (const x of alongDepth(backX)) strand([x, 0.02, z], [x, topAt(x), z]);
    for (let y = NET_STEP; y < H - 0.05; y += NET_STEP) {
      // Up to the back's height a strand runs the whole depth; above it, only
      // from where the sloping top reaches this height on to the post.
      const from = y <= B ? backX : backX + ((postX - backX) * (y - B)) / (H - B);
      strand([from, y, z], [postX + out * 0.04, y, z]);
    }
  }
  for (let z = zN + NET_STEP; z < zS - 0.05; z += NET_STEP) strand([backX, B, z], [postX, H, z]);
  for (const x of alongDepth(backX)) strand([x, topAt(x), zN], [x, topAt(x), zS]);
}

// ---------------------------------------------------------------------------
// The stands
// ---------------------------------------------------------------------------

/** Seat colour: West's blue on the west half, East's red on the east half. */
function seatColour(x: number, seed: number): Paint {
  return jitterColor(x < PITCH_HALFWAY_X ? PITCH_THEME.west : PITCH_THEME.east, seed, 0.03);
}

/**
 * The main stand along the north side: concrete tiers stepping up away from
 * the field, a row of seats on each, two aisles, a back wall and a roof on
 * posts. It fills its footing to the square's north edge; nothing of it
 * reaches the walkway in front.
 */
function stand(piece: PitchFixture, bin: GeometryBin): void {
  const x0 = piece.x;
  const x1 = piece.x + piece.width;
  const front = piece.y + piece.height;
  const tiers = piece.height - 1;
  const aisles = [x0 + piece.width * 0.25, x0 + piece.width * 0.75];
  for (let i = 0; i < tiers; i++) {
    const zb = front - i;
    const za = zb - 1;
    const top = STAND_TIER_RISE * (i + 1);
    bin.add(DECOR, boxGeometry(x0, 0, za, x1, top, zb), i % 2 === 0 ? PITCH_THEME.concrete : shade(PITCH_THEME.concrete, -0.03));
    // A row of seats on the tier, broken by the aisles.
    for (let x = x0 + 0.2; x + 0.42 <= x1 - 0.15; x += 0.55) {
      if (aisles.some((aisle) => x + 0.42 > aisle - 0.45 && x < aisle + 0.45)) continue;
      const seed = hash01(Math.round(x * 10), i, 921);
      bin.add(DECOR, boxGeometry(x, top, za + 0.4, x + 0.42, top + 0.16, za + 0.8), seatColour(x, seed));
      bin.add(DECOR, boxGeometry(x, top, za + 0.28, x + 0.42, top + 0.42, za + 0.38), seatColour(x, seed + 0.5));
    }
  }
  // Steps up each aisle, then the back: a concourse and its wall.
  for (const aisle of aisles) {
    for (let i = 0; i < tiers; i++) {
      const zb = front - i;
      for (let k = 0; k < 2; k++) {
        bin.add(
          DECOR,
          boxGeometry(aisle - 0.4, STAND_TIER_RISE * i + (STAND_TIER_RISE / 2) * (k + 1), zb - (k + 1) * 0.5, aisle + 0.4, STAND_TIER_RISE * i + (STAND_TIER_RISE / 2) * (k + 1) + 0.02, zb - k * 0.5),
          PITCH_THEME.concreteDark,
        );
      }
    }
  }
  const backTop = STAND_TIER_RISE * (tiers + 1);
  bin.add(DECOR, boxGeometry(x0, 0, piece.y, x1, backTop, piece.y + 1), PITCH_THEME.concreteDark);
  bin.add(DECOR, boxGeometry(x0, backTop, piece.y, x1, backTop + 0.9, piece.y + 0.25), PITCH_THEME.concreteDark);
  // The roof, on posts along the back, over the upper tiers.
  for (let x = x0 + 0.3; x < x1; x += (piece.width - 0.6) / 4) {
    bin.add(DECOR, boxGeometry(x - 0.08, backTop, piece.y + 0.3, x + 0.08, STAND_ROOF_Y, piece.y + 0.46), PITCH_THEME.steel);
  }
  bin.add(DECOR, boxGeometry(x0 - 0.2, STAND_ROOF_Y, piece.y, x1 + 0.2, STAND_ROOF_Y + 0.12, piece.y + 3.1), PITCH_THEME.roof);
  bin.add(DECOR, boxGeometry(x0 - 0.2, STAND_ROOF_Y - 0.16, piece.y + 2.98, x1 + 0.2, STAND_ROOF_Y + 0.14, piece.y + 3.12), PITCH_THEME.steel);
  // The scoreboard's frame and legs, over the roof at the halfway line.
  const half = PITCH_THEME.scoreboard.width / 2;
  const boardBottom = PITCH_SCOREBOARD_Y - PITCH_THEME.scoreboard.height / 2;
  for (const dx of [-half + 0.5, half - 0.5]) {
    bin.add(DECOR, boxGeometry(PITCH_HALFWAY_X + dx - 0.07, STAND_ROOF_Y + 0.12, piece.y + 0.3, PITCH_HALFWAY_X + dx + 0.07, boardBottom, piece.y + 0.42), PITCH_THEME.steel);
  }
  bin.add(
    DECOR,
    boxGeometry(PITCH_HALFWAY_X - half - 0.12, boardBottom - 0.1, piece.y + 0.22, PITCH_HALFWAY_X + half + 0.12, PITCH_SCOREBOARD_Y + PITCH_THEME.scoreboard.height / 2 + 0.1, piece.y + 0.45),
    PITCH_THEME.steel,
  );
}

/** A low bleacher along the south side: two concrete steps, a wooden bench on each. */
function bleacher(piece: PitchFixture, bin: GeometryBin): void {
  const x0 = piece.x + 0.1;
  const x1 = piece.x + piece.width - 0.1;
  // The step and the plank on it are BLEACHER_PROFILE's: the front row's plank
  // is what a sitter rests on (D-127, amended 2026-10-03), so the drawn bench
  // and the seat under a seated figure are the same numbers.
  const seat = BLEACHER_PROFILE;
  const plank = seat.surface - seat.underside;
  for (let i = 0; i < piece.height; i++) {
    const za = piece.y + i;
    const top = seat.underside * (i + 1);
    bin.add(DECOR, boxGeometry(x0, 0, za, x1, top, za + 1), i === 0 ? PITCH_THEME.concrete : shade(PITCH_THEME.concrete, -0.03));
    // Measured from the row's south edge, which is the back of a north-facing run.
    bin.add(DECOR, boxGeometry(x0 + 0.05, top, za + 1 - seat.seatFront, x1 - 0.05, top + plank, za + 1 - seat.seatBack), PLAZA_THEME.wood);
    for (let x = x0 + 0.4; x < x1 - 0.2; x += 1.6) {
      bin.add(DECOR, boxGeometry(x, top, za + 0.3, x + 0.08, top + 0.02, za + 0.52), PLAZA_THEME.woodDark);
    }
  }
  bin.add(DECOR, boxGeometry(x0, 0.6, piece.y + piece.height - 0.12, x1, 0.9, piece.y + piece.height - 0.04), PITCH_THEME.steel);
}

const scratchMatrix = new Matrix4();
const scratchQuat = new Quaternion();
const scratchPosition = new Vector3();
const scratchScale = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);
const TILT_AXIS = new Vector3(1, 0, 0);
const scratchTilt = new Quaternion();

/** A floodlight in a corner: a plinth, a tall pole and a bank of lamps aimed at the centre spot. */
function floodlight(piece: PitchFixture, bin: GeometryBin): void {
  const cx = piece.x + piece.width / 2;
  const cz = piece.y + piece.height / 2;
  bin.add(DECOR, boxGeometry(cx - 0.32, 0, cz - 0.32, cx + 0.32, 0.3, cz + 0.32), PITCH_THEME.concreteDark);
  bin.add(DECOR, cylinderGeometry(cx, 0.3, cz, 0.07, 0.11, 7.1, 8), PITCH_THEME.pole);
  const top = 7.4;
  // The head faces the centre spot, tipped down toward it.
  const yaw = Math.atan2(PITCH_CENTRE_SPOT.x - cx, PITCH_CENTRE_SPOT.z - cz);
  scratchQuat.setFromAxisAngle(UP, yaw);
  scratchTilt.setFromAxisAngle(TILT_AXIS, 0.5);
  scratchQuat.multiply(scratchTilt);
  scratchMatrix.compose(scratchPosition.set(cx, top, cz), scratchQuat, scratchScale);
  bin.add(DECOR, new BoxGeometry(1.5, 0.95, 0.14).applyMatrix4(scratchMatrix), PITCH_THEME.pole);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const lamp = new BoxGeometry(0.38, 0.3, 0.04).translate(-0.46 + col * 0.46, -0.2 + row * 0.42, 0.09);
      bin.add(GLOW, lamp.applyMatrix4(scratchMatrix), PITCH_THEME.lamp);
    }
  }
}

// ---------------------------------------------------------------------------
// The fence and the gate
// ---------------------------------------------------------------------------

/** The fence tiles either side of the gate, where the gate's posts stand. */
function gatePosts(map: DistrictMap): { north: number; south: number } | null {
  const north = PITCH_GATE.y - 1;
  const south = PITCH_GATE.y + PITCH_GATE.height;
  if (map.tiles[north]?.[PITCH_GATE.x] !== 'railing' || map.tiles[south]?.[PITCH_GATE.x] !== 'railing') return null;
  return { north, south };
}

/**
 * The square's street side: a green steel fence on every railing tile, a
 * post at each tile and bars between, and at the gate two tall posts carrying
 * a lintel with the gate's board. What rises above the fence at the gate is
 * the superstructure, in its own mesh so it can fade.
 */
function streetFence(map: DistrictMap, bin: GeometryBin): void {
  const x = PITCH_GATE.x;
  const cx = x + 0.5;
  for (let z = 0; z < map.height; z++) {
    if (map.tiles[z]?.[x] !== 'railing') continue;
    bin.add(DECOR, boxGeometry(x + 0.2, 0, z, x + 0.8, 0.14, z + 1), PITCH_THEME.kerb);
    bin.add(DECOR, boxGeometry(cx - 0.06, 0.14, z + 0.02, cx + 0.06, FENCE_HEIGHT, z + 0.14), PITCH_THEME.steel);
    for (const y of [0.3, FENCE_HEIGHT - 0.06]) bin.add(DECOR, boxGeometry(cx - 0.03, y, z, cx + 0.03, y + 0.06, z + 1), PITCH_THEME.steel);
    for (let k = 1; k < 5; k++) {
      const bz = z + k * 0.2;
      bin.add(DECOR, boxGeometry(cx - 0.015, 0.14, bz - 0.012, cx + 0.015, FENCE_HEIGHT - 0.06, bz + 0.012), PITCH_THEME.mesh);
    }
  }
  const posts = gatePosts(map);
  if (!posts) return;
  // The gate's posts, full height on their fence tiles; above the fence they are superstructure.
  for (const z of [posts.north, posts.south]) {
    bin.add(DECOR, boxGeometry(cx - 0.2, 0, z + 0.3, cx + 0.2, FENCE_HEIGHT, z + 0.7), PITCH_THEME.steel);
    bin.add(GATE, boxGeometry(cx - 0.2, FENCE_HEIGHT, z + 0.3, cx + 0.2, GATE_POST_TOP, z + 0.7), PITCH_THEME.steel);
    bin.add(GATE, boxGeometry(cx - 0.26, GATE_POST_TOP, z + 0.24, cx + 0.26, GATE_POST_TOP + 0.08, z + 0.76), PITCH_THEME.boardTop);
  }
  bin.add(GATE, boxGeometry(cx - 0.2, LINTEL_BOTTOM, posts.north + 0.3, cx + 0.2, LINTEL_TOP, posts.south + 0.7), PITCH_THEME.steel);
  bin.add(GATE, boxGeometry(cx - 0.21, LINTEL_BOTTOM + 0.06, posts.north + 0.3, cx + 0.21, LINTEL_BOTTOM + 0.1, posts.south + 0.7), PITCH_THEME.east);
  // The board's two hangers, above head height.
  const hanger = PITCH_THEME.gate.width / 2 - 0.4;
  const zc = (posts.north + posts.south + 1) / 2;
  for (const dz of [-hanger, hanger]) {
    bin.add(GATE, boxGeometry(cx + 0.2, LINTEL_BOTTOM + 0.1, zc + dz - 0.03, cx + 0.24, LINTEL_TOP, zc + dz + 0.03), PITCH_THEME.steel);
  }
}

/**
 * The rest of the square's fence, just off the map on its north, west and
 * south edges: posts and rails, tall behind the stand and low on the south,
 * nearest the camera. Outside the map, so never in anyone's way.
 */
function perimeterFence(map: DistrictMap, bin: GeometryBin): void {
  const { x: x0, y: z0, width } = PITCH_AREA;
  const x1 = x0 + width;
  // The south run follows the map's edge, not the square's: since D-134 the
  // district is deeper than the square, and a fence on the square's own south
  // edge would stand across the grass inside it.
  const z1 = Math.max(z0 + PITCH_AREA.height, map.height);
  const run = (xa: number, za: number, xb: number, zb: number, h: number): void => {
    const alongX = Math.abs(xb - xa) >= Math.abs(zb - za);
    const length = alongX ? Math.abs(xb - xa) : Math.abs(zb - za);
    const count = Math.max(1, Math.round(length / 2));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const px = xa + (xb - xa) * t;
      const pz = za + (zb - za) * t;
      bin.add(DECOR, boxGeometry(px - 0.05, 0, pz - 0.05, px + 0.05, h, pz + 0.05), PITCH_THEME.steel);
    }
    for (const y of [0.35, h / 2 + 0.1, h - 0.05]) {
      const [ax, az, bx, bz] = alongX ? [xa, za - 0.02, xb, zb + 0.02] : [xa - 0.02, za, xb + 0.02, zb];
      bin.add(DECOR, boxGeometry(ax, y - 0.03, az, bx, y + 0.03, bz), PITCH_THEME.steel);
    }
  };
  run(x0, z0 - 0.08, x1 + 0.5, z0 - 0.08, 2.2);
  run(x0 - 0.08, z0, x0 - 0.08, z1, 1.6);
  run(x0, z1 + 0.08, x1 + 0.5, z1 + 0.08, 1.1);
}

function gateOccluder(mesh: Mesh, posts: { north: number; south: number }, materials: readonly Material[]): PitchOccluder {
  const box = new Box3().setFromObject(mesh);
  const x = PITCH_GATE.x;
  const post = (z: number): OccluderBounds =>
    Object.freeze({ minX: x + 0.3, maxX: x + 0.7, minZ: z + 0.3, maxZ: z + 0.7, minY: FENCE_HEIGHT, height: GATE_POST_TOP + 0.08 });
  const lintel: OccluderBounds = Object.freeze({
    minX: box.min.x,
    maxX: box.max.x,
    minZ: posts.north + 0.3,
    maxZ: posts.south + 0.7,
    minY: LINTEL_BOTTOM - 0.4,
    height: box.max.y,
  });
  return Object.freeze({
    kind: 'pitch',
    part: 'gate',
    object: mesh,
    bounds: Object.freeze({ ...lintel, minY: FENCE_HEIGHT }),
    boxes: Object.freeze([post(posts.north), post(posts.south), lintel]),
    setOpacity: createOpacityFader(materials),
  });
}
