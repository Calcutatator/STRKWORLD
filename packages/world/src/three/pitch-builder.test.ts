import { describe, expect, it } from 'vitest';
import { Box3, Color, Material, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three';
import {
  FOOTBALL_POST_RADIUS,
  PITCH_AREA,
  PITCH_FIELD,
  PITCH_GATES,
  PITCH_GOAL,
  PITCH_PEN,
  PITCH_SLOTS,
  pitchSlotSide,
} from '@strkworld/shared';
import { PITCH_CENTRE_SPOT, PITCH_FIXTURES, PITCH_GATE, PITCH_GATE_TEXT, PITCH_HALFWAY_X, PITCH_MIDDLE_Z } from '../map/pitch.js';
import { createStreetMap, isSolidAt } from '../map/street.js';
import { CAMERA_FOV, createCameraRig } from './camera-rig.js';
import { createNullLabelFactory } from './labels.js';
import { PITCH_THEME } from './palette.js';
import { PITCH_BOARD_HEIGHT, PITCH_GOAL_HEIGHT, PITCH_LINE_WIDTH, PITCH_SCOREBOARD_Y, type PitchOccluder } from './pitch-builder.js';
import { buildStreet, type StreetOccluder } from './street-builder.js';
import type { StreetView } from './types.js';

/**
 * The football pitch in the street scene (D-078). Built through
 * `buildStreet`, the way the renderer builds it, so every assertion is about
 * the scene the player gets.
 */

function build(): { view: StreetView; pitchLabels: Object3D[] } {
  const view = buildStreet(createStreetMap(), createNullLabelFactory());
  view.ground.updateMatrixWorld(true);
  const pitchLabels = view.labels.children.filter((child) => child.userData['area'] === 'pitch');
  return { view, pitchLabels };
}

function meshNamed(root: Object3D, name: string): Mesh {
  let found: Mesh | undefined;
  root.traverse((object) => {
    if (!found && object instanceof Mesh && object.name === name) found = object;
  });
  if (!found) throw new Error(`no mesh ${name}`);
  return found;
}

function vertices(mesh: Mesh): Vector3[] {
  const position = mesh.geometry.getAttribute('position');
  const out: Vector3[] = [];
  for (let i = 0; i < position.count; i++) out.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  return out;
}

function materialsOf(root: Object3D): Material[] {
  const found: Material[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(...(Array.isArray(object.material) ? object.material : [object.material]));
  });
  return found;
}

describe('the pitch in 3D (D-078)', () => {
  it('adds four meshes and two signs to the street: its ground, its decor, its gate and its floodlights', () => {
    const { view, pitchLabels } = build();
    const names: string[] = [];
    view.ground.traverse((object) => {
      if (object instanceof Mesh && object.name.startsWith('pitch:')) names.push(object.name);
    });
    expect(names.sort()).toEqual(['pitch:decor', 'pitch:floodlights', 'pitch:gate', 'pitch:ground']);
    expect(pitchLabels.map((label) => label.userData['pitch'])).toEqual(['scoreboard', 'gate']);
    view.dispose();
  });

  it('lays the field flat and paints its lines inside it: touchlines, halfway line, centre circle and both boxes', () => {
    const { view } = build();
    const ground = vertices(meshNamed(view.ground, 'pitch:ground'));
    const lines = ground.filter((v) => Math.abs(v.y - 0.012) < 1e-6);
    // Every line is on the field.
    for (const v of lines) {
      expect(v.x).toBeGreaterThanOrEqual(PITCH_FIELD.x - 1e-6);
      expect(v.x).toBeLessThanOrEqual(PITCH_FIELD.x + PITCH_FIELD.width + 1e-6);
      expect(v.z).toBeGreaterThanOrEqual(PITCH_FIELD.y - 1e-6);
      expect(v.z).toBeLessThanOrEqual(PITCH_FIELD.y + PITCH_FIELD.height + 1e-6);
    }
    const near = (x: number, z: number, tolerance = 0.05) => lines.some((v) => Math.abs(v.x - x) < tolerance && Math.abs(v.z - z) < tolerance);
    // The halfway line runs the field's width through the centre spot.
    expect(near(PITCH_HALFWAY_X - PITCH_LINE_WIDTH / 2, PITCH_FIELD.y + PITCH_LINE_WIDTH)).toBe(true);
    expect(near(PITCH_HALFWAY_X + PITCH_LINE_WIDTH / 2, PITCH_FIELD.y + PITCH_FIELD.height - PITCH_LINE_WIDTH)).toBe(true);
    // The centre circle, north of the spot, and each penalty area's far corner.
    expect(near(PITCH_CENTRE_SPOT.x, PITCH_CENTRE_SPOT.z - 2.2, 0.1)).toBe(true);
    expect(near(PITCH_FIELD.x + 3.6, PITCH_MIDDLE_Z - 4.5, 0.12)).toBe(true);
    expect(near(PITCH_FIELD.x + PITCH_FIELD.width - 3.6, PITCH_MIDDLE_Z + 4.5, 0.12)).toBe(true);
    // Nothing of the ground rises above a kerb: the boards stay knee-low.
    expect(Math.max(...ground.map((v) => v.y))).toBeLessThanOrEqual(PITCH_BOARD_HEIGHT + 1e-6);
    expect(PITCH_BOARD_HEIGHT).toBeLessThan(0.15);
    view.dispose();
  });

  it('stands a white goal on each goal\'s footing, its posts just behind the line and its crossbar above a player', () => {
    const { view } = build();
    const decor = vertices(meshNamed(view.ground, 'pitch:decor'));
    for (const piece of PITCH_FIXTURES.filter((fixture) => fixture.kind === 'goal')) {
      const east = piece.side === 'snarks';
      const line = east ? PITCH_FIELD.x + PITCH_FIELD.width : PITCH_FIELD.x;
      const postX = line + (east ? 1 : -1) * FOOTBALL_POST_RADIUS;
      for (const z of [PITCH_MIDDLE_Z - PITCH_GOAL.width / 2, PITCH_MIDDLE_Z + PITCH_GOAL.width / 2]) {
        const post = decor.filter((v) => Math.abs(v.x - postX) < 0.1 && Math.abs(v.z - z) < 0.1);
        expect(post.length, `${piece.side} post at ${z}`).toBeGreaterThan(0);
        expect(Math.max(...post.map((v) => v.y))).toBeGreaterThanOrEqual(PITCH_GOAL_HEIGHT);
      }
      // Every part of the frame stands over the goal's own solid footing.
      const frame = decor.filter((v) => v.z > piece.y - 0.2 && v.z < piece.y + piece.height + 0.2 && (east ? v.x > line - 0.2 && v.x < line + 1.2 : v.x < line + 0.2 && v.x > line - 1.2));
      expect(frame.length).toBeGreaterThan(0);
    }
    expect(PITCH_GOAL_HEIGHT).toBeGreaterThan(1.4);
    view.dispose();
  });

  it('keeps every volume on solid footing or off the map, and the field and walkway clear', () => {
    const map = createStreetMap();
    const { view } = build();
    for (const name of ['pitch:decor', 'pitch:gate']) {
      for (const v of vertices(meshNamed(view.ground, name))) {
        if (v.y < 0.15 || v.y > 1.9) continue;
        const inside = v.x > 0.02 && v.x < PITCH_AREA.x + PITCH_AREA.width + 0.98 && v.z > 0.02 && v.z < PITCH_AREA.height - 0.02;
        if (!inside) continue;
        // A vertex on a tile boundary belongs to both; one solid neighbour is enough.
        const solid = [[-0.01, -0.01], [0.01, -0.01], [-0.01, 0.01], [0.01, 0.01]].some(([dx, dz]) =>
          isSolidAt(map, Math.floor(v.x + dx!), Math.floor(v.z + dz!)),
        );
        expect(solid, `${name} at (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`).toBe(true);
      }
    }
    view.dispose();
  });

  it('names the score on a brand plate over the stand, "STARKS 0 – 0 SNARKS", whole in the camera from the far walkway', () => {
    const { view, pitchLabels } = build();
    const board = pitchLabels.find((label) => label.userData['pitch'] === 'scoreboard')!;
    expect(board.userData['kind']).toBe('sign');
    expect(board.userData['text']).toBe('STARKS 0 – 0 SNARKS');
    expect(board.userData['options']).toMatchObject({ titleFont: 'display', background: PITCH_THEME.scoreboard.background });
    expect(board.rotation.y).toBe(0);
    expect(board.position.x).toBe(PITCH_HALFWAY_X);
    expect(board.position.y).toBe(PITCH_SCOREBOARD_Y);
    const stand = PITCH_FIXTURES.find((piece) => piece.kind === 'stand')!;
    expect(board.position.z).toBeGreaterThan(stand.y);
    expect(board.position.z).toBeLessThan(stand.y + stand.height);
    const { width, height } = board.userData['options'] as { width: number; height: number };
    for (const z of [PITCH_FIELD.y + PITCH_FIELD.height + 1.5, PITCH_MIDDLE_Z]) {
      const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
      createCameraRig({ camera }).update(16, { x: PITCH_HALFWAY_X, z }, null);
      camera.updateMatrixWorld(true);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const ndc = new Vector3(board.position.x + (dx * width) / 2, board.position.y + (dy * height) / 2, board.position.z).project(camera);
        expect(Math.abs(ndc.x), `from z ${z}`).toBeLessThan(1);
        expect(Math.abs(ndc.y), `from z ${z}`).toBeLessThan(1);
      }
    }
    // The score follows the ball's: the pitch view redraws it.
    view.pitch!.setScore(3, 5);
    expect(board.userData['text']).toBe('STARKS 3 – 5 SNARKS');
    view.pitch!.setScore(Number.NaN, 1);
    expect(board.userData['text']).toBe('STARKS 0 – 1 SNARKS');
    view.dispose();
  });

  it('hangs the gate board over the gate, facing the street, above head height, and fades the gate alone', () => {
    const { view, pitchLabels } = build();
    const sign = pitchLabels.find((label) => label.userData['pitch'] === 'gate')!;
    expect(sign.userData['text']).toBe(PITCH_GATE_TEXT);
    // A sign faces +Z at rotation 0; this faces +X, the street.
    expect(sign.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(sign.position.x).toBeGreaterThan(PITCH_GATE.x);
    expect(sign.position.z).toBe(PITCH_GATE.y + PITCH_GATE.height / 2);
    expect(sign.position.y - PITCH_THEME.gate.height / 2).toBeGreaterThan(2.4);
    const gate = (view.occluders as readonly StreetOccluder[]).filter((occluder): occluder is PitchOccluder => occluder.kind === 'pitch');
    expect(gate).toHaveLength(1);
    const mesh = meshNamed(view.ground, 'pitch:gate');
    expect(gate[0]!.object).toBe(mesh);
    // Nothing of it hangs below the fence over the opening, so the way in is clear.
    const box = new Box3().setFromObject(mesh);
    expect(box.min.y).toBeGreaterThanOrEqual(1.5 - 1e-6);
    const own = materialsOf(mesh);
    const others = materialsOf(view.ground).filter((material) => !own.includes(material));
    gate[0]!.setOpacity(0.3);
    for (const material of own) expect(material.opacity).toBeCloseTo(0.3);
    for (const material of others) expect(material.opacity).toBe(1);
    gate[0]!.setOpacity(1);
    for (const material of own) expect(material.opacity).toBe(1);
    view.dispose();
  });
});

describe('the pitch\'s own fence and its two gates (D-135)', () => {
  /** Whether any decor vertex stands over tile (x, z) between the kerb and the rail top. */
  function fenced(decor: Mesh, x: number, z: number): boolean {
    return vertices(decor).some(
      (v) => v.y > 0.2 && v.y < 1.3 && v.x > x - 1e-6 && v.x < x + 1 + 1e-6 && v.z > z - 1e-6 && v.z < z + 1 + 1e-6,
    );
  }

  it('closes a ring of railing round the pen, leaving the stands outside it', () => {
    const { view } = build();
    const decor = meshNamed(view.ground, 'pitch:decor');
    const x1 = PITCH_PEN.x + PITCH_PEN.width;
    const z1 = PITCH_PEN.y + PITCH_PEN.height;
    // Every tile of the border carries fence, the gates' tiles included.
    for (let x = PITCH_PEN.x; x < x1; x++) {
      for (const z of [PITCH_PEN.y, z1 - 1]) expect(fenced(decor, x, z), `${x},${z}`).toBe(true);
    }
    for (let z = PITCH_PEN.y; z < z1; z++) {
      for (const x of [PITCH_PEN.x, x1 - 1]) expect(fenced(decor, x, z), `${x},${z}`).toBe(true);
    }
    // And the field itself carries none of it.
    expect(fenced(decor, PITCH_FIELD.x + 4, PITCH_FIELD.y + 4)).toBe(false);
    view.dispose();
  });

  it('stands the gates\' posts above the railing, one gate north and one south', () => {
    const { view } = build();
    const decor = meshNamed(view.ground, 'pitch:decor');
    const points = vertices(decor);
    expect(PITCH_GATES.map((gate) => gate.side)).toEqual(['north', 'south']);
    for (const gate of PITCH_GATES) {
      const line = gate.tiles.y + 0.5;
      // A post taller than the railing at each end of the leaf.
      for (const x of [gate.tiles.x, gate.tiles.x + gate.tiles.width]) {
        const tall = points.some(
          (v) => Math.abs(v.x - x) < 0.2 && Math.abs(v.z - line) < 0.2 && v.y > 1.3 && v.y <= 2.4,
        );
        expect(tall, `${gate.side} post at ${x}`).toBe(true);
      }
      // The gate is closed: bars stand over its own tiles, so it is no gap.
      for (let x = gate.tiles.x; x < gate.tiles.x + gate.tiles.width; x++) {
        expect(fenced(decor, x, gate.tiles.y), `${gate.side} leaf ${x}`).toBe(true);
      }
    }
    view.dispose();
  });
});

describe('the match\'s dummies (D-135)', () => {
  /** The four dummy figures, in slot order. */
  function dummies(view: StreetView): Mesh[] {
    const found: Mesh[] = [];
    view.figures.traverse((object) => {
      if (object instanceof Mesh && object.name.startsWith('pitch:dummy-')) found.push(object);
    });
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  it('builds one figure per place, hidden until a match puts a dummy there', () => {
    const { view } = build();
    const figures = dummies(view);
    expect(figures).toHaveLength(PITCH_SLOTS);
    expect(figures.every((mesh) => !mesh.visible)).toBe(true);
    // They live outside the static scene, which must stay clear of walkable tiles.
    expect(dummies({ ...view, figures: view.ground } as StreetView)).toHaveLength(0);
    view.dispose();
  });

  it('stands each dummy where the server says, and hides a place that holds a player or nobody', () => {
    const { view } = build();
    const place = (kind: 'empty' | 'player' | 'dummy', x = 0, y = 0) => ({ kind, x, y });
    view.pitch!.setDummies([
      place('dummy', 10 * 32, 11 * 32),
      place('player'),
      place('empty'),
      place('dummy', 20 * 32, 19 * 32),
    ]);
    const figures = dummies(view);
    expect(figures.map((mesh) => mesh.visible)).toEqual([true, false, false, true]);
    // World pixels become world units, one per street tile.
    expect(figures[0]!.position.x).toBeCloseTo(10);
    expect(figures[0]!.position.z).toBeCloseTo(11);
    expect(figures[3]!.position.x).toBeCloseTo(20);
    expect(figures[3]!.position.z).toBeCloseTo(19);
    // An empty list — which is what a null match sends — hides them all.
    view.pitch!.setDummies([]);
    expect(dummies(view).some((mesh) => mesh.visible)).toBe(false);
    view.dispose();
  });

  it('faces each dummy at the goal its team attacks, and wears its team\'s colour', () => {
    const { view } = build();
    const figures = dummies(view);
    figures.forEach((mesh, index) => {
      const side = pitchSlotSide(index);
      // The Starks attack east (+X), the Snarks west.
      expect(mesh.rotation.y, `slot ${index}`).toBeCloseTo(side === 'starks' ? Math.PI / 2 : -Math.PI / 2);
    });
    // Each team's sack colour appears in its own figures and not the other's.
    const colours = (mesh: Mesh): Set<string> => {
      const attribute = mesh.geometry.getAttribute('color');
      const set = new Set<string>();
      for (let i = 0; i < attribute.count; i++) {
        set.add(new Color(attribute.getX(i), attribute.getY(i), attribute.getZ(i)).getHexString());
      }
      return set;
    };
    const starks = new Color(PITCH_THEME.starks).getHexString();
    const snarks = new Color(PITCH_THEME.snarks).getHexString();
    expect(colours(figures[0]!).has(starks)).toBe(true);
    expect(colours(figures[0]!).has(snarks)).toBe(false);
    expect(colours(figures[1]!).has(snarks)).toBe(true);
    expect(colours(figures[1]!).has(starks)).toBe(false);
    view.dispose();
  });

  it('ignores a place whose coordinates are not numbers', () => {
    const { view } = build();
    view.pitch!.setDummies([
      { kind: 'dummy', x: Number.NaN, y: 0 },
      { kind: 'dummy', x: 0, y: Number.POSITIVE_INFINITY },
      { kind: 'empty', x: 0, y: 0 },
      { kind: 'empty', x: 0, y: 0 },
    ]);
    expect(dummies(view).some((mesh) => mesh.visible)).toBe(false);
    view.dispose();
  });
});
