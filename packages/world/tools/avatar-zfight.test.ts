import { afterAll, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, Mesh } from 'three';
import { AVATAR_SPRITE_KEYS, pairedAvatarSprite } from '../src/avatar-state.js';
import { createAvatarFigure, disposeAvatarFigureCache, type AvatarPartBox } from '../src/three/avatar-figure.js';
import {
  ZFIGHT_GAP,
  findAvatarZFights,
  formatZFight,
  zFightPoses,
  zFightsInFigure,
} from './avatar-zfight.js';

const CHECK_TIMEOUT_MS = 60_000;

interface TestBox {
  readonly size: readonly [number, number, number];
  readonly at: readonly [number, number, number];
  readonly color: number;
}

/** A part geometry built the way PartBuilder builds one: non-indexed boxes, coloured per vertex, recorded in order. */
function partGeometry(boxes: readonly TestBox[]): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const records: AvatarPartBox[] = [];
  for (const box of boxes) {
    const source = new BoxGeometry(...box.size).translate(...box.at).toNonIndexed();
    const first = position.length / 9;
    position.push(...source.getAttribute('position').array);
    normal.push(...source.getAttribute('normal').array);
    const c = new Color(box.color);
    for (let i = 0; i < source.getAttribute('position').count; i += 1) color.push(c.r, c.g, c.b);
    records.push({ tag: 'test', socket: null, first, count: position.length / 9 - first });
    source.dispose();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(color, 3));
  geometry.userData = { avatarPartBoxes: records };
  return geometry;
}

function headOf(boxes: readonly TestBox[]): Group {
  const root = new Group();
  const mesh = new Mesh(partGeometry(boxes));
  mesh.name = 'avatar-head';
  root.add(mesh);
  return root;
}

const SKIN: TestBox = { size: [0.5, 0.5, 0.5], at: [0, 0.25, 0], color: 0xd98f58 };
/** A hair cap whose front is `front` in front of the forehead (negative: behind it). */
const cap = (front: number, color = 0xdea53a): TestBox => ({
  size: [0.56, 0.15, 0.4],
  at: [0, 0.45, 0.25 + front - 0.2],
  color,
});

afterAll(() => {
  disposeAvatarFigureCache();
});

describe('avatar z-fighting (tools/avatar-zfight.ts)', () => {
  it('checks the clipping poses plus a jump', () => {
    const names = zFightPoses().map((pose) => pose.name);
    expect(names.filter((name) => name.startsWith('walk'))).toHaveLength(16);
    expect(names.filter((name) => name.startsWith('sprint'))).toHaveLength(16);
    expect(names.filter((name) => name.startsWith('jump')).length).toBeGreaterThanOrEqual(4);
  });

  it.each(AVATAR_SPRITE_KEYS)(
    '%s: no two faces of different colours share a plane, standing, walking, sprinting or jumping',
    (key) => {
      expect(findAvatarZFights(key).map(formatZFight)).toEqual([]);
    },
    CHECK_TIMEOUT_MS,
  );

  it('finds a hair cap whose front is level with the forehead, as the bearded elder’s was', () => {
    const findings = zFightsInFigure(headOf([SKIN, cap(0)]), 'avatar-4', 'test');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ a: 'avatar-head:test#0', b: 'avatar-head:test#1', face: '+z' });
    expect(findings[0]!.gap).toBeLessThan(1e-6);
    // Within the gap still fights; the fixed margin clears it either way.
    expect(zFightsInFigure(headOf([SKIN, cap(ZFIGHT_GAP / 2)]), 'avatar-4', 'test')).toHaveLength(1);
    expect(zFightsInFigure(headOf([SKIN, cap(0.01)]), 'avatar-4', 'test')).toEqual([]);
    expect(zFightsInFigure(headOf([SKIN, cap(-0.01)]), 'avatar-4', 'test')).toEqual([]);
  });

  it('ignores level faces nobody can tell apart or see: one colour, or covered by a third box', () => {
    expect(zFightsInFigure(headOf([SKIN, cap(0, SKIN.color)]), 'avatar-4', 'test')).toEqual([]);
    const visor: TestBox = { size: [0.6, 0.2, 0.05], at: [0, 0.45, 0.27], color: 0x333333 };
    expect(zFightsInFigure(headOf([SKIN, cap(0), visor]), 'avatar-4', 'test')).toEqual([]);
  });

  it.each(AVATAR_SPRITE_KEYS)(
    '%s: the outfit swap replaces each part in place, never showing the old and new outfits together',
    (key) => {
      const paired = pairedAvatarSprite(key);
      const figure = createAvatarFigure(key);
      const fresh = createAvatarFigure(paired);
      try {
        const meshes = (root: Group | typeof figure.object): Mesh[] => {
          const found: Mesh[] = [];
          root.traverse((object) => {
            if (object instanceof Mesh) found.push(object);
          });
          return found;
        };
        const before = meshes(figure.object);
        const oldGeometry = new Set(before.map((mesh) => mesh.geometry));
        figure.setLook(paired);
        const after = meshes(figure.object);
        // The same seven meshes, none added: each part's geometry was swapped, not stacked.
        expect(after).toHaveLength(7);
        expect(after).toEqual(before);
        const expected = new Map(meshes(fresh.object).map((mesh) => [mesh.name, mesh.geometry]));
        for (const mesh of after) {
          expect(mesh.geometry).toBe(expected.get(mesh.name));
          if (mesh.name !== 'avatar-eyes') expect(oldGeometry.has(mesh.geometry)).toBe(false);
        }
        expect(zFightsInFigure(figure.object, paired, 'after swap').map(formatZFight)).toEqual([]);
      } finally {
        figure.dispose();
        fresh.dispose();
      }
    },
  );
});
