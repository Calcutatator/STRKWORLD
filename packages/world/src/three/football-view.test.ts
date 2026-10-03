import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Color, InstancedMesh, Material, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { FOOTBALL_BALL_RADIUS, PITCH_FIELD } from '@strkworld/shared';
import type { FootballFrame } from '../football-channel.js';
import { PITCH_CENTRE_SPOT, PITCH_FULL_TIME_TEXT, PITCH_GOAL_TEXT, PITCH_KICK_PROMPT, PITCH_MIDDLE_Z } from '../map/pitch.js';
import { createNullLabelFactory } from './labels.js';
import { PITCH_THEME } from './palette.js';
import {
  CONFETTI_COUNT,
  CONFETTI_MS,
  FULL_TIME_CHEER_MS,
  GOAL_CHEER_MS,
  buildFootball,
  footballGeometry,
} from './football-view.js';

/**
 * The football in 3D (D-078): the ball where the session says, its roll and
 * shadow, "E · KICK", and GOAL! and FULL TIME, held still for a player who
 * asked for less motion.
 */

const T = 32;
const frame = (x: number, z: number, extra: Partial<FootballFrame> = {}): FootballFrame => ({
  x: x * T,
  y: z * T,
  vx: 0,
  vy: 0,
  starks: 0,
  snarks: 0,
  phase: 'live',
  ...extra,
});

/** Advance a view by `ms` in frames of 50 ms, as the renderer does. */
function run(view: { update(deltaMs: number): void }, ms: number): void {
  for (let t = 0; t < ms; t += 50) view.update(Math.min(50, ms - t));
}

function part(root: Object3D, name: string): Object3D {
  const found = root.getObjectByName(name) ?? root.children.find((child) => child.userData['football'] === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

describe('the ball (D-078)', () => {
  it('is a white ball of dark pentagon patches, flat-shaded and low-poly', () => {
    const geometry = footballGeometry();
    const colour = geometry.getAttribute('color');
    const dark = new Color(PITCH_THEME.ballDark);
    let darkFaces = 0;
    for (let i = 0; i < colour.count; i += 3) if (Math.abs(colour.getX(i) - dark.r) < 1e-6) darkFaces += 1;
    // Twelve patches of five faces on a twice-subdivided icosahedron's 180.
    expect(colour.count / 3).toBe(180);
    expect(darkFaces).toBe(60);
    geometry.computeBoundingSphere();
    expect(geometry.boundingSphere!.radius).toBeCloseTo(FOOTBALL_BALL_RADIUS, 5);
    geometry.dispose();
  });

  it('stands on the turf where the frame says, with its shadow under it, and hides when there is none', () => {
    const view = buildFootball({ labels: createNullLabelFactory() });
    const ball = part(view.group, 'football:ball');
    const shadow = part(view.group, 'football:shadow');
    expect(ball.visible).toBe(false);
    view.setBall(frame(12, 14.5));
    expect(ball.visible).toBe(true);
    expect(ball.position.toArray()).toEqual([12, FOOTBALL_BALL_RADIUS, 14.5]);
    expect(shadow.visible).toBe(true);
    expect([shadow.position.x, shadow.position.z]).toEqual([12, 14.5]);
    expect(shadow.position.y).toBeGreaterThan(0);
    expect(shadow.position.y).toBeLessThan(0.05);
    view.setBall(null);
    expect(ball.visible).toBe(false);
    expect(shadow.visible).toBe(false);
    view.dispose();
  });

  it('rolls the way it goes, without slipping, and not at all when it stands still', () => {
    const view = buildFootball({ labels: createNullLabelFactory() });
    const ball = part(view.group, 'football:ball');
    view.setBall(frame(10, 15));
    const start = ball.quaternion.clone();
    view.setBall(frame(10, 15));
    expect(ball.quaternion.equals(start)).toBe(true);
    // A quarter turn's worth of travel snarks: the ball's top turns east.
    const quarter = (Math.PI / 2) * FOOTBALL_BALL_RADIUS;
    view.setBall(frame(10 + quarter, 15));
    const up = new Vector3(0, 1, 0).applyQuaternion(ball.quaternion);
    expect(up.x).toBeCloseTo(1, 5);
    expect(up.y).toBeCloseTo(0, 5);
    // A teleport (a kick-off) does not spin it.
    const before = ball.quaternion.clone();
    view.setBall(frame(PITCH_CENTRE_SPOT.x, PITCH_CENTRE_SPOT.z));
    expect(ball.quaternion.angleTo(before)).toBeCloseTo(0, 6);
    view.dispose();
  });

  it('shows "E · KICK" over the ball while the session says so, and only with a ball to kick', () => {
    const view = buildFootball({ labels: createNullLabelFactory() });
    const prompt = part(view.group, 'prompt');
    expect(prompt.userData['text']).toBe(PITCH_KICK_PROMPT);
    view.setPrompt(true);
    expect(prompt.visible).toBe(false);
    view.setBall(frame(12, 14));
    expect(prompt.visible).toBe(true);
    expect([prompt.position.x, prompt.position.z]).toEqual([12, 14]);
    expect(prompt.position.y).toBeGreaterThan(FOOTBALL_BALL_RADIUS * 2);
    view.setPrompt(false);
    expect(prompt.visible).toBe(false);
    view.dispose();
  });
});

describe('the pitch\'s moments (D-078)', () => {
  const confettiOf = (view: ReturnType<typeof buildFootball>): InstancedMesh => part(view.group, 'football:confetti') as InstancedMesh;

  it('cheers GOAL! over the goal it went into, and throws confetti out of its mouth into the field', () => {
    const view = buildFootball({ labels: createNullLabelFactory() });
    const cheer = part(view.group, 'cheer');
    view.celebrate({ kind: 'goal', side: 'starks' });
    expect(cheer.visible).toBe(true);
    expect(cheer.userData['text']).toBe(PITCH_GOAL_TEXT);
    // West scores into the east goal.
    expect(cheer.position.x).toBeGreaterThan(PITCH_FIELD.x + PITCH_FIELD.width);
    expect(cheer.position.z).toBe(PITCH_MIDDLE_Z);
    const confetti = confettiOf(view);
    expect(confetti.count).toBe(CONFETTI_COUNT);
    run(view, 400);
    const matrix = new Matrix4();
    const position = new Vector3();
    let intoField = 0;
    for (let i = 0; i < confetti.count; i++) {
      confetti.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      if (position.x < PITCH_FIELD.x + PITCH_FIELD.width) intoField += 1;
      expect(position.y).toBeGreaterThan(0);
    }
    expect(intoField).toBeGreaterThan(CONFETTI_COUNT * 0.8);
    // The confetti goes, then the words.
    run(view, CONFETTI_MS - 400);
    expect(confetti.count).toBe(0);
    expect(cheer.visible).toBe(true);
    run(view, GOAL_CHEER_MS - CONFETTI_MS);
    expect(cheer.visible).toBe(false);
    view.dispose();
  });

  it('holds FULL TIME over the centre spot, naming the winner and the score', () => {
    const view = buildFootball({ labels: createNullLabelFactory() });
    const cheer = part(view.group, 'cheer');
    view.celebrate({ kind: 'full-time', winner: 'snarks', starks: 1, snarks: 3 });
    expect(cheer.userData['text']).toBe(`${PITCH_FULL_TIME_TEXT}\nSNARKS WIN 3 – 1`);
    expect([cheer.position.x, cheer.position.z]).toEqual([PITCH_CENTRE_SPOT.x, PITCH_CENTRE_SPOT.z]);
    run(view, FULL_TIME_CHEER_MS - 100);
    expect(cheer.visible).toBe(true);
    run(view, 200);
    expect(cheer.visible).toBe(false);
    view.dispose();
  });

  it('holds the words still and throws no confetti for a player who asked for less motion, read at each moment', () => {
    let still = true;
    const view = buildFootball({ labels: createNullLabelFactory(), reducedMotion: () => still });
    const cheer = part(view.group, 'cheer');
    view.celebrate({ kind: 'goal', side: 'snarks' });
    expect(confettiOf(view).count).toBe(0);
    const y = cheer.position.y;
    view.update(300);
    expect(cheer.scale.x).toBe(1);
    expect(cheer.position.y).toBe(y);
    expect(cheer.visible).toBe(true);
    still = false;
    view.celebrate({ kind: 'goal', side: 'snarks' });
    expect(confettiOf(view).count).toBe(CONFETTI_COUNT);
    view.update(100);
    expect(cheer.scale.x).not.toBe(1);
    view.dispose();
  });

  it('starts clean on reset, and disposes everything it made exactly once', () => {
    const view = buildFootball({ labels: createNullLabelFactory() });
    view.setBall(frame(12, 14));
    view.setPrompt(true);
    view.celebrate({ kind: 'goal', side: 'starks' });
    view.reset();
    expect(part(view.group, 'football:ball').visible).toBe(false);
    expect(part(view.group, 'prompt').visible).toBe(false);
    expect(part(view.group, 'cheer').visible).toBe(false);
    expect(confettiOf(view).count).toBe(0);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    view.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      materials.add(object.material as Material);
    });
    const spies = [...geometries, ...materials].map((value) => vi.spyOn(value, 'dispose'));
    const labels = view.group.children.filter((child) => child.userData['football']);
    view.dispose();
    view.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    for (const label of labels) expect(label.userData['disposed']).toBe(true);
    expect(view.group.children).toHaveLength(0);
    // After disposal nothing moves.
    view.setBall(frame(1, 1));
    view.update(16);
    void Quaternion;
  });
});
