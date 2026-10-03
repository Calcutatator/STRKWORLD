import {
  BoxGeometry,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import {
  FOOTBALL_BALL_RADIUS,
  FOOTBALL_SIDE_GOAL,
  PITCH_FIELD,
  PITCH_GOAL,
  type FootballSide,
} from '@strkworld/shared';
import type { FootballFrame, FootballMoment } from '../football-channel.js';
import {
  PITCH_CENTRE_SPOT,
  PITCH_FULL_TIME_TEXT,
  PITCH_GOAL_TEXT,
  PITCH_KICK_PROMPT,
  PITCH_MIDDLE_Z,
  pitchWinnerText,
} from '../map/pitch.js';
import { PIXELS_PER_UNIT } from './coords.js';
import { PITCH_THEME, hash01 } from './palette.js';
import type { LabelFactory, TextLabel } from './types.js';

/**
 * The shared football in 3D (D-078): a low-poly ball rolling where the
 * Shell's channel says, a soft contact shadow under it, "E · KICK" over it
 * while the player can kick it, and the pitch's two moments — GOAL! over the
 * goal it went into with a burst of confetti in both sides' colours, and FULL
 * TIME over the centre spot naming the winner.
 *
 * Presentation only: the ball's position and every moment come from the
 * session. A player who asked for less motion (`prefers-reduced-motion`,
 * read at each moment, as the sandbox burst reads it) gets the words held
 * still and no confetti.
 */

export interface FootballView {
  readonly group: Group;
  /** Draw the ball here this frame, or hide it. */
  setBall(frame: FootballFrame | null): void;
  /** Show "E · KICK" over the ball, or not. */
  setPrompt(visible: boolean): void;
  /** A goal or full time. */
  celebrate(moment: FootballMoment): void;
  /** Drop any celebration at once: a new session starts clean. */
  reset(): void;
  update(deltaMs: number): void;
  dispose(): void;
}

export interface FootballViewOptions {
  readonly labels: LabelFactory;
  /** Whether the player asked for less motion; read at each moment. */
  readonly reducedMotion?: () => boolean;
}

/** The ball's radius in world units. */
export const BALL_RADIUS = FOOTBALL_BALL_RADIUS;
/** How long GOAL! stays up, and FULL TIME, in ms: the authority's own celebration lengths, a little short of them. */
export const GOAL_CHEER_MS = 2300;
export const FULL_TIME_CHEER_MS = 4200;
/** Confetti pieces in one burst, and how long they fly. */
export const CONFETTI_COUNT = 48;
export const CONFETTI_MS = 1600;
/** Where the words hang: over a goal, and higher over the centre spot. */
const GOAL_CHEER_Y = 2.9;
const FULL_TIME_Y = 3.4;
const PROMPT_Y = 0.95;
const CONFETTI_GRAVITY = 9;

const scratchMatrix = new Matrix4();
const scratchQuat = new Quaternion();
const scratchSpin = new Quaternion();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchAxis = new Vector3();

/**
 * A low-poly football: a twice-subdivided icosahedron (180 faces),
 * flat-shaded, white with a dark five-face patch round each of the twelve
 * original corners, so it reads as a ball of pentagons from the fixed camera.
 */
export function footballGeometry(radius = BALL_RADIUS): BufferGeometry {
  const base = new IcosahedronGeometry(radius, 2);
  const geometry = base.index ? base.toNonIndexed() : base;
  if (geometry !== base) base.dispose();
  const corners = new IcosahedronGeometry(1, 0);
  const cornerPositions = corners.getAttribute('position');
  const directions: Vector3[] = [];
  for (let i = 0; i < cornerPositions.count; i++) {
    const v = new Vector3().fromBufferAttribute(cornerPositions, i).normalize();
    if (!directions.some((d) => d.distanceTo(v) < 1e-4)) directions.push(v);
  }
  corners.dispose();
  const position = geometry.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const light = new Color(PITCH_THEME.ballLight);
  const dark = new Color(PITCH_THEME.ballDark);
  const centroid = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    centroid.copy(a).add(b).add(c).normalize();
    const patch = directions.some((d) => d.dot(centroid) > Math.cos((17 * Math.PI) / 180));
    const colour = patch ? dark : light;
    for (let k = 0; k < 3; k++) colours.set([colour.r, colour.g, colour.b], (i + k) * 3);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The goal a side scores into: the Starks keep the west goal, so they score
 * into the east one (D-135, `FOOTBALL_SIDE_GOAL`). Its mouth's centre, in
 * world units.
 */
function goalMouth(side: FootballSide): { x: number; z: number; into: number } {
  const east = FOOTBALL_SIDE_GOAL[side] === 'west';
  const line = east ? PITCH_FIELD.x + PITCH_FIELD.width : PITCH_FIELD.x;
  // `into` points from the goal back into the field, where the confetti flies.
  return { x: line + (east ? PITCH_GOAL.depth / 2 : -PITCH_GOAL.depth / 2), z: PITCH_MIDDLE_Z, into: east ? -1 : 1 };
}

interface Piece {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  axis: Vector3;
  colour: number;
}

export function buildFootball(options: FootballViewOptions): FootballView {
  const group = new Group();
  group.name = 'football';
  const reducedMotion = (): boolean => {
    try {
      return options.reducedMotion?.() === true;
    } catch {
      return false;
    }
  };

  const ballGeometry = footballGeometry();
  const ballMaterial = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55 });
  const ball = new Mesh(ballGeometry, ballMaterial);
  ball.name = 'football:ball';
  ball.castShadow = true;
  ball.visible = false;
  group.add(ball);

  const shadowGeometry = new CircleGeometry(BALL_RADIUS * 1.15, 18).rotateX(-Math.PI / 2);
  const shadowMaterial = new MeshBasicMaterial({ color: PITCH_THEME.shadow, transparent: true, opacity: 0.34, depthWrite: false });
  const shadow = new Mesh(shadowGeometry, shadowMaterial);
  shadow.name = 'football:shadow';
  shadow.renderOrder = 1;
  shadow.visible = false;
  group.add(shadow);

  const labels: TextLabel[] = [];
  const addLabel = (label: TextLabel, part: string): TextLabel => {
    labels.push(label);
    label.object.visible = false;
    label.object.userData['football'] = part;
    group.add(label.object);
    return label;
  };
  const prompt = addLabel(options.labels.floating(PITCH_KICK_PROMPT, PITCH_THEME.prompt), 'prompt');
  const cheer = addLabel(options.labels.floating(PITCH_GOAL_TEXT, PITCH_THEME.cheer), 'cheer');

  const pieceGeometry = new BoxGeometry(0.2, 0.02, 0.13);
  const pieceMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const confetti = new InstancedMesh(pieceGeometry, pieceMaterial, CONFETTI_COUNT);
  confetti.name = 'football:confetti';
  confetti.count = 0;
  confetti.frustumCulled = false;
  group.add(confetti);

  let disposed = false;
  let promptShown = false;
  let elapsed = 0;
  /** Where the ball was last drawn, for its roll; null while hidden. */
  let last: { x: number; z: number } | null = null;
  const roll = new Quaternion();
  /** The words up now, and until when; null for none. */
  let shown: { until: number; baseY: number; still: boolean; start: number } | null = null;
  let pieces: Piece[] = [];
  let piecesAge = 0;

  const place = (): void => {
    const x = ball.position.x;
    const z = ball.position.z;
    shadow.position.set(x, 0.012, z);
    prompt.object.position.set(x, PROMPT_Y + (promptShown ? 0.05 * Math.sin((elapsed / 1000) * 3) : 0), z);
  };

  const hideCheer = (): void => {
    shown = null;
    cheer.object.visible = false;
    cheer.object.scale.setScalar(1);
  };

  const clearConfetti = (): void => {
    pieces = [];
    confetti.count = 0;
  };

  const launch = (x: number, z: number, into: number, fountain: boolean): void => {
    pieces = [];
    piecesAge = 0;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const r1 = hash01(i, 1, 941);
      const r2 = hash01(i, 2, 941);
      const r3 = hash01(i, 3, 941);
      const angle = fountain ? r1 * Math.PI * 2 : (r1 - 0.5) * 2.2;
      const speed = 3 + r2 * 4;
      const colour = PITCH_THEME.confetti[i % PITCH_THEME.confetti.length]!;
      pieces.push({
        x,
        y: 0.6 + r3 * 0.6,
        z,
        // Out of the goal's mouth into the field, fanned wide; or all round, from the centre spot.
        vx: fountain ? Math.cos(angle) * speed * 0.7 : into * (1.5 + Math.cos(angle) * speed),
        vy: 3.5 + r3 * 3,
        vz: fountain ? Math.sin(angle) * speed * 0.7 : Math.sin(angle) * speed * 0.9,
        spin: 6 + r2 * 10,
        axis: new Vector3(r1 - 0.5, r2 - 0.5, r3 - 0.5).normalize(),
        colour,
      });
      confetti.setColorAt(i, new Color(colour));
    }
    confetti.count = pieces.length;
    if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
    drawConfetti();
  };

  const drawConfetti = (): void => {
    const t = piecesAge / 1000;
    const shrink = Math.max(0, Math.min(1, (CONFETTI_MS - piecesAge) / 400));
    pieces.forEach((piece, i) => {
      const y = Math.max(0.02, piece.y + piece.vy * t - 0.5 * CONFETTI_GRAVITY * t * t);
      scratchPosition.set(piece.x + piece.vx * t, y, piece.z + piece.vz * t);
      scratchQuat.setFromAxisAngle(piece.axis, piece.spin * t);
      scratchScale.setScalar(shrink);
      scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
      confetti.setMatrixAt(i, scratchMatrix);
    });
    confetti.instanceMatrix.needsUpdate = true;
  };

  return {
    group,
    setBall(frame) {
      if (disposed) return;
      if (frame === null) {
        ball.visible = false;
        shadow.visible = false;
        prompt.object.visible = false;
        last = null;
        return;
      }
      const x = frame.x / PIXELS_PER_UNIT;
      const z = frame.y / PIXELS_PER_UNIT;
      if (last !== null) {
        // Roll without slipping: about the ground-plane axis across the way it went.
        const dx = x - last.x;
        const dz = z - last.z;
        const distance = Math.hypot(dx, dz);
        if (distance > 1e-6 && distance < 3) {
          scratchAxis.set(dz / distance, 0, -dx / distance);
          scratchSpin.setFromAxisAngle(scratchAxis, distance / BALL_RADIUS);
          roll.premultiply(scratchSpin);
        }
      }
      last = { x, z };
      ball.position.set(x, BALL_RADIUS, z);
      ball.quaternion.copy(roll);
      ball.visible = true;
      shadow.visible = true;
      prompt.object.visible = promptShown;
      place();
    },
    setPrompt(visible) {
      if (disposed) return;
      promptShown = visible === true;
      prompt.object.visible = promptShown && ball.visible;
      place();
    },
    celebrate(moment) {
      if (disposed) return;
      const still = reducedMotion();
      if (moment.kind === 'goal') {
        const mouth = goalMouth(moment.side);
        cheer.setText(PITCH_GOAL_TEXT);
        cheer.object.position.set(mouth.x, GOAL_CHEER_Y, mouth.z);
        shown = { until: elapsed + GOAL_CHEER_MS, baseY: GOAL_CHEER_Y, still, start: elapsed };
        if (still) clearConfetti();
        else launch(mouth.x, mouth.z, mouth.into, false);
      } else {
        cheer.setText(`${PITCH_FULL_TIME_TEXT}\n${pitchWinnerText(moment.starks, moment.snarks)}`);
        cheer.object.position.set(PITCH_CENTRE_SPOT.x, FULL_TIME_Y, PITCH_CENTRE_SPOT.z);
        shown = { until: elapsed + FULL_TIME_CHEER_MS, baseY: FULL_TIME_Y, still, start: elapsed };
        if (still) clearConfetti();
        else launch(PITCH_CENTRE_SPOT.x, PITCH_CENTRE_SPOT.z, 0, true);
      }
      cheer.object.visible = true;
      cheer.object.scale.setScalar(1);
    },
    reset() {
      if (disposed) return;
      hideCheer();
      clearConfetti();
      promptShown = false;
      prompt.object.visible = false;
      ball.visible = false;
      shadow.visible = false;
      last = null;
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      if (promptShown && prompt.object.visible) place();
      if (shown) {
        if (elapsed >= shown.until) {
          hideCheer();
        } else if (!shown.still) {
          // A pop in, then a gentle bob.
          const age = elapsed - shown.start;
          const pop = Math.min(1, age / 180);
          cheer.object.scale.setScalar(0.6 + 0.4 * pop + 0.08 * Math.sin(Math.min(1, age / 360) * Math.PI));
          cheer.object.position.y = shown.baseY + 0.08 * Math.sin((elapsed / 1000) * 2.6);
        }
      }
      if (pieces.length > 0) {
        piecesAge += dt;
        if (piecesAge >= CONFETTI_MS) clearConfetti();
        else drawConfetti();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const label of labels) label.dispose();
      labels.length = 0;
      group.removeFromParent();
      group.clear();
      ballGeometry.dispose();
      ballMaterial.dispose();
      shadowGeometry.dispose();
      shadowMaterial.dispose();
      pieceGeometry.dispose();
      pieceMaterial.dispose();
      confetti.dispose();
    },
  };
}
