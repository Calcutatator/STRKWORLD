import { describe, expect, it } from 'vitest';
import { Box3, InstancedMesh, Material, Mesh, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { STREET_ORIGIN_X } from '@strkworld/shared';
import { PLAZA_AREA, PLAZA_FIXTURES, PLAZA_MONUMENT_STATION, PLAZA_SHELLS_STATION, PLAZA_SIGN_TEXT } from '../map/plaza.js';
import { createStreetMap, isSolidAt } from '../map/street.js';
import { CAMERA_FOV, createCameraRig } from './camera-rig.js';
import { SIGN_PIXELS_PER_UNIT, createNullLabelFactory, layoutSignText, splitLabelLines } from './labels.js';
import { PLAZA_THEME, STRK20, css } from './palette.js';
import {
  PLAZA_FACE_CAPTIONS,
  PLAZA_HELD_CYCLE_MS,
  PLAZA_UNKNOWN_FIGURE,
  plazaFaceText,
  type PlazaOccluder,
} from './plaza-builder.js';
import { PAVEMENT_HEIGHT, buildStreet, streetSurfaceHeightAt, type StreetOccluder } from './street-builder.js';
import type { StreetView } from './types.js';

/**
 * The Privacy Plaza in the street scene (D-076). Built through `buildStreet`,
 * the way the renderer builds it, so every assertion is about the scene the
 * player gets.
 */

/** The street's first column (D-078); the plaza is laid out from it. */
const X = STREET_ORIGIN_X;

function build(): { view: StreetView; plazaLabels: Object3D[] } {
  const view = buildStreet(createStreetMap(), createNullLabelFactory());
  const plazaLabels = view.labels.children.filter((child) => child.userData['area'] === 'plaza');
  return { view, plazaLabels };
}

const labelFor = (labels: Object3D[], part: string): Object3D => {
  const found = labels.find((child) => child.userData['plaza'] === part);
  if (!found) throw new Error(`no plaza label ${part}`);
  return found;
};

function meshNamed(root: Object3D, name: string): Mesh {
  let found: Mesh | undefined;
  root.traverse((object) => {
    if (!found && object instanceof Mesh && object.name === name) found = object;
  });
  if (!found) throw new Error(`no mesh ${name}`);
  return found;
}

function plazaOccluders(view: StreetView): PlazaOccluder[] {
  return (view.occluders as readonly StreetOccluder[]).filter((occluder): occluder is PlazaOccluder => occluder.kind === 'plaza');
}

/** Draw calls (meshes, sprites, one per null label) and triangles under `root`, as the street budget counts them. */
function cost(roots: readonly Object3D[], labels: readonly Object3D[]): { calls: number; triangles: number } {
  let calls = labels.length;
  let triangles = 0;
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      calls += 1;
      const index = object.geometry.getIndex();
      const count = index ? index.count : object.geometry.getAttribute('position').count;
      triangles += (count / 3) * (object instanceof InstancedMesh ? object.count : 1);
    });
  }
  return { calls, triangles };
}

describe('the Privacy Plaza in 3D (D-076)', () => {
  it('adds its paving, furniture, monument, gateway and lights to the street ground', () => {
    const { view } = build();
    const names = view.ground.children.map((child) => child.name);
    expect(names).toEqual(expect.arrayContaining(['plaza:paving', 'plaza:decor', 'plaza:monument', 'plaza:gateway', 'plaza:glow']));
    expect(view.plaza).not.toBeNull();
    view.dispose();
  });

  it('paves level with the pavement and walks straight in from it', () => {
    const map = createStreetMap();
    const { view } = build();
    for (let y = PLAZA_AREA.y; y < PLAZA_AREA.y + PLAZA_AREA.height; y++) {
      for (let x = PLAZA_AREA.x; x < PLAZA_AREA.x + PLAZA_AREA.width; x++) {
        expect(streetSurfaceHeightAt(map, x + 0.5, y + 0.5), `${x},${y}`).toBe(PAVEMENT_HEIGHT);
      }
    }
    // No kerb rises between the pavement and the plaza's gateway opening.
    const pavement = meshNamed(view.ground, 'street:pavement');
    pavement.updateMatrixWorld(true);
    const position = pavement.geometry.getAttribute('position');
    const vertex = new Vector3();
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(pavement.matrixWorld);
      if (vertex.x > 4.05 && vertex.x < 6.95 && vertex.z > 18.6 && vertex.z < 19.05) {
        expect(vertex.y).toBeLessThanOrEqual(PAVEMENT_HEIGHT + 1e-6);
      }
    }
    const paving = new Box3().setFromObject(meshNamed(view.ground, 'plaza:paving'));
    expect(paving.min.x).toBeCloseTo(PLAZA_AREA.x);
    expect(paving.max.x).toBeCloseTo(PLAZA_AREA.x + PLAZA_AREA.width);
    expect(paving.min.z).toBeCloseTo(PLAZA_AREA.y);
    expect(paving.max.z).toBeCloseTo(PLAZA_AREA.y + PLAZA_AREA.height);
    expect(paving.max.y).toBeLessThan(0.15);
    view.dispose();
  });

  it('keeps every plaza volume on its furniture tiles below head height', () => {
    const map = createStreetMap();
    const { view } = build();
    for (const name of ['plaza:decor', 'plaza:monument', 'plaza:gateway', 'plaza:glow']) {
      const mesh = meshNamed(view.ground, name);
      mesh.updateMatrixWorld(true);
      const position = mesh.geometry.getAttribute('position');
      const vertex = new Vector3();
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        if (vertex.y < 0.15 || vertex.y > 1.9) continue;
        // Nudged inward a hair, a vertex on a tile edge belongs to its own tile.
        const tx = Math.floor(vertex.x + (vertex.x % 1 === 0 ? 1e-3 : 0));
        const tz = Math.floor(vertex.z + (vertex.z % 1 === 0 ? 1e-3 : 0));
        const solid = isSolidAt(map, tx, tz) || isSolidAt(map, Math.floor(vertex.x - 1e-3), Math.floor(vertex.z - 1e-3));
        expect(solid, `${name} at ${vertex.x.toFixed(2)},${vertex.y.toFixed(2)},${vertex.z.toFixed(2)}`).toBe(true);
      }
    }
    view.dispose();
  });

  it('names itself on a brand plate hung under the gateway lintel, facing the camera, above head height', () => {
    const { view, plazaLabels } = build();
    const sign = labelFor(plazaLabels, 'sign');
    expect(sign.userData['text']).toBe(PLAZA_SIGN_TEXT);
    expect(sign.userData['kind']).toBe('sign');
    expect(sign.userData['options']).toMatchObject({
      titleFont: 'display',
      uppercase: true,
      background: css(STRK20.surface),
      gradient: [css(STRK20.cream), css(STRK20.blush), css(STRK20.peach)],
    });
    expect(sign.rotation.y).toBe(0);
    const { width, height } = sign.userData['options'] as { width: number; height: number };
    // Over the opening between the posts, clear of anyone walking through.
    expect(sign.position.x).toBeCloseTo(X + 5.5);
    expect(sign.position.y - height / 2).toBeGreaterThan(2.3);
    expect(sign.position.x - width / 2).toBeGreaterThan(X + 3.7);
    expect(sign.position.x + width / 2).toBeLessThan(X + 7.3);
    // Whole in the fixed camera's frame from the south pavement in front of it.
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
    createCameraRig({ camera }).update(16, { x: X + 5.5, z: 17.5 }, null);
    camera.updateMatrixWorld(true);
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const ndc = new Vector3(sign.position.x + (dx * width) / 2, sign.position.y + (dy * height) / 2, sign.position.z).project(camera);
      expect(Math.abs(ndc.x)).toBeLessThan(1);
      expect(Math.abs(ndc.y)).toBeLessThan(1);
    }
    view.dispose();
  });

  it('shows "…" on all three monument faces until the Shell sends figures', () => {
    const { view, plazaLabels } = build();
    const accounts = labelFor(plazaLabels, 'accounts');
    const deposits = labelFor(plazaLabels, 'deposits24h');
    const held = labelFor(plazaLabels, 'held');
    expect(accounts.userData['text']).toBe(`${PLAZA_UNKNOWN_FIGURE}\n${PLAZA_FACE_CAPTIONS.accounts}`);
    expect(deposits.userData['text']).toBe(`${PLAZA_UNKNOWN_FIGURE}\n${PLAZA_FACE_CAPTIONS.deposits24h}`);
    expect(held.userData['text']).toBe(`${PLAZA_UNKNOWN_FIGURE}\n${PLAZA_FACE_CAPTIONS.held}`);
    // Two faces on the turned shaft look south-west and south-east; the third is the die's front.
    expect(accounts.rotation.y).toBeCloseTo(-Math.PI / 4);
    expect(deposits.rotation.y).toBeCloseTo(Math.PI / 4);
    expect(held.rotation.y).toBe(0);
    expect(held.position.x).toBeCloseTo(X + 5.5);
    expect(accounts.userData['options']).toMatchObject(PLAZA_THEME.face);
    for (const face of [accounts, deposits, held]) {
      expect(face.userData['options']).toMatchObject({ background: css(STRK20.black), accent: css(STRK20.orange) });
    }
    view.dispose();
  });

  it("keeps all three faces whole in the fixed camera's frame, facing it, from the plaza's south side", () => {
    const { view, plazaLabels } = build();
    view.labels.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
    createCameraRig({ camera }).update(16, { x: X + 5.5, z: 26.5 }, null);
    camera.updateMatrixWorld(true);
    for (const part of ['accounts', 'deposits24h', 'held']) {
      const face = labelFor(plazaLabels, part);
      const { width, height } = face.userData['options'] as { width: number; height: number };
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const ndc = new Vector3((dx * width) / 2, (dy * height) / 2, 0).applyMatrix4(face.matrixWorld).project(camera);
        expect(Math.abs(ndc.x), part).toBeLessThan(1);
        expect(Math.abs(ndc.y), part).toBeLessThan(1);
      }
      // Its front, not its back, is towards the camera.
      const normal = new Vector3(0, 0, 1).applyQuaternion(face.getWorldQuaternion(new Quaternion()));
      const toCamera = camera.position.clone().sub(face.getWorldPosition(new Vector3())).normalize();
      expect(normal.dot(toCamera), part).toBeGreaterThan(0.3);
    }
    view.dispose();
  });

  it('prints each figure large on its plate, whatever the caption', () => {
    // The canvas fits a plate's lines to its widest; with a plain width
    // estimate (0.62 em a character, mono captions tracked wider), the figure
    // must still stand at least a fifth of the plate's height.
    for (const [text, options] of [
      [plazaFaceText('99,999', PLAZA_FACE_CAPTIONS.accounts), PLAZA_THEME.face],
      [plazaFaceText('1,234', PLAZA_FACE_CAPTIONS.deposits24h), PLAZA_THEME.face],
      [plazaFaceText('$1.18M', PLAZA_FACE_CAPTIONS.held), { ...PLAZA_THEME.face, width: 1.66, height: 0.6 }],
      [plazaFaceText('xSTRK · $453K', PLAZA_FACE_CAPTIONS.held), { ...PLAZA_THEME.face, width: 1.66, height: 0.6 }],
    ] as const) {
      const width = options.width * SIGN_PIXELS_PER_UNIT;
      const height = options.height * SIGN_PIXELS_PER_UNIT;
      const layout = layoutSignText(
        splitLabelLines(text.toUpperCase()),
        (line, px, index = 0) => line.length * px * (index === 0 ? 0.62 : 0.7),
        { width, height, padding: Math.max(2, height * 0.05) * 2.6 },
      );
      expect(layout[0]!.fontPx / height, text).toBeGreaterThan(0.2);
    }
  });

  it('draws the figures it is given, and "…" again for a part that goes unknown', () => {
    const { view, plazaLabels } = build();
    view.plaza!.setStats({ accounts: '2,932', deposits24h: '23', valueUsd: '$1.18M', topHoldings: null });
    expect(labelFor(plazaLabels, 'accounts').userData['text']).toBe(plazaFaceText('2,932', PLAZA_FACE_CAPTIONS.accounts));
    expect(labelFor(plazaLabels, 'deposits24h').userData['text']).toBe('23\nDEPOSITS\nLAST 24 H');
    expect(labelFor(plazaLabels, 'held').userData['text']).toBe('$1.18M\nHELD IN THE POOL');
    view.plaza!.setStats({ accounts: '2,933', deposits24h: null, valueUsd: null, topHoldings: null });
    expect(labelFor(plazaLabels, 'accounts').userData['text']).toBe('2,933\nACCOUNTS\nREGISTERED');
    expect(labelFor(plazaLabels, 'deposits24h').userData['text']).toBe('…\nDEPOSITS\nLAST 24 H');
    expect(labelFor(plazaLabels, 'held').userData['text']).toBe('…\nHELD IN THE POOL');
    view.dispose();
  });

  it('takes turns on the held face between the USD total and each top holding', () => {
    const { view, plazaLabels } = build();
    const held = labelFor(plazaLabels, 'held');
    view.plaza!.setStats({
      accounts: '1',
      deposits24h: '1',
      valueUsd: '$1.18M',
      topHoldings: ['xSTRK · $453K', 'USDC · $198K'],
    });
    // The total leads; then each holding, in order; then back to the total.
    expect(held.userData['text']).toMatch(/^\$1\.18M\n/);
    // The street integrates at most 250 ms a frame.
    const advance = (ms: number): void => {
      for (let left = ms; left > 0; left -= 250) view.update(Math.min(250, left));
    };
    advance(PLAZA_HELD_CYCLE_MS);
    expect(held.userData['text']).toMatch(/^xSTRK · \$453K\n/);
    advance(PLAZA_HELD_CYCLE_MS);
    expect(held.userData['text']).toMatch(/^USDC · \$198K\n/);
    advance(PLAZA_HELD_CYCLE_MS);
    expect(held.userData['text']).toMatch(/^\$1\.18M\n/);
    // With no top holdings, the total alone stays put.
    view.plaza!.setStats({ accounts: '1', deposits24h: '1', valueUsd: '$1.18M', topHoldings: null });
    advance(PLAZA_HELD_CYCLE_MS * 2);
    expect(held.userData['text']).toMatch(/^\$1\.18M\n/);
    view.dispose();
  });

  it('shows an E prompt over the station the player stands at, and only that one', () => {
    const { view, plazaLabels } = build();
    const prompts = plazaLabels.filter((child) => child.userData['plaza'] === 'prompt');
    expect(prompts.map((prompt) => prompt.userData['station'])).toEqual([PLAZA_MONUMENT_STATION, PLAZA_SHELLS_STATION]);
    expect(prompts.map((prompt) => prompt.userData['text'])).toEqual(['E · POOL STATS', "E · WHERE'S THE NOTE?"]);
    expect(prompts.every((prompt) => !prompt.visible)).toBe(true);
    view.plaza!.setHighlight(PLAZA_SHELLS_STATION);
    expect(prompts.map((prompt) => prompt.visible)).toEqual([false, true]);
    view.plaza!.setHighlight(PLAZA_MONUMENT_STATION);
    expect(prompts.map((prompt) => prompt.visible)).toEqual([true, false]);
    view.plaza!.setHighlight(null);
    expect(prompts.every((prompt) => !prompt.visible)).toBe(true);
    // The table carries its game's name all the time.
    expect(labelFor(plazaLabels, 'card').userData['text']).toBe("WHERE'S THE NOTE?");
    view.dispose();
  });

  it('fades the monument and the gateway on their own, like buildings, and restores them exactly', () => {
    const { view } = build();
    const occluders = plazaOccluders(view);
    expect(occluders.map((occluder) => occluder.part)).toEqual(['monument', 'gateway']);
    const monument = PLAZA_FIXTURES.find((piece) => piece.kind === 'monument')!;
    expect(occluders[0]!.bounds).toMatchObject({ minX: monument.x, maxX: monument.x + monument.width, minZ: monument.y, maxZ: monument.y + monument.height });
    expect(occluders[0]!.bounds.height).toBeGreaterThan(4);
    // The gateway is solid only in its posts and its span, so walking under the sign is clear.
    expect(occluders[1]!.boxes).toHaveLength(3);
    expect(occluders[1]!.boxes![2]!.minY).toBeGreaterThan(2.3);
    const own = (occluder: PlazaOccluder): Material[] => {
      const found: Material[] = [];
      occluder.object.traverse((object) => {
        if (object instanceof Mesh) found.push(object.material as Material);
      });
      return found;
    };
    const decor = meshNamed(view.ground, 'plaza:decor').material as Material;
    for (const occluder of occluders) {
      const materials = own(occluder);
      occluder.setOpacity(0.3);
      for (const material of materials) {
        expect(material.opacity).toBeCloseTo(0.3);
        expect(material.transparent).toBe(true);
      }
      expect(decor.opacity).toBe(1);
      occluder.setOpacity(1);
      for (const material of materials) {
        expect(material.opacity).toBe(1);
        expect(material.transparent).toBe(false);
        expect(material.depthWrite).toBe(true);
      }
    }
    view.dispose();
  });

  it('costs twelve draw calls and a few thousand triangles, leaving the street well inside its budget', () => {
    const { view, plazaLabels } = build();
    const plazaMeshes = view.ground.children.filter((child) => child.name.startsWith('plaza:'));
    const plaza = cost(plazaMeshes, plazaLabels);
    // Five merged meshes, and seven labels: the sign, three faces, the card and two prompts.
    expect(plaza.calls).toBe(12);
    expect(plaza.triangles).toBeGreaterThan(1_000);
    expect(plaza.triangles).toBeLessThan(4_000);
    const street = cost([view.ground, view.doors, view.labels], view.labels.children);
    expect(street.calls).toBeLessThan(150);
    view.dispose();
  });

  it('animates deterministically', () => {
    const first = build();
    const second = build();
    for (const part of [first, second]) {
      part.view.plaza!.setStats({ accounts: '1', deposits24h: '2', valueUsd: '$3', topHoldings: ['A · $4'] });
      part.view.plaza!.setHighlight(PLAZA_SHELLS_STATION);
    }
    const sample = (part: ReturnType<typeof build>) => part.plazaLabels.map((label) => [label.userData['text'], label.position.y]);
    for (const delta of [16, 900, 3_500, 250, 16]) {
      first.view.update(delta);
      second.view.update(delta);
    }
    expect(sample(first)).toEqual(sample(second));
    first.view.dispose();
    second.view.dispose();
  });
});
