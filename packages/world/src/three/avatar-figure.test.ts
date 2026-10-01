import { afterEach, describe, expect, it } from 'vitest';
import { Box3, Color, Group, Mesh, Vector3, type Material, type Object3D } from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { AVATAR_SPRITE_KEYS } from '../avatar-state.js';
import {
  AVATAR_FIGURE_HEIGHT,
  avatarFigureHeight,
  avatarPartBoxes,
  createAvatarFigure,
  disposeAvatarFigureCache,
} from './avatar-figure.js';
import { avatarLook, type AvatarBuild } from './avatar-looks.js';
import type { AvatarFigure, AvatarMotion } from './types.js';

const IDLE: AvatarMotion = { moving: false, sprinting: false };
const WALK: AvatarMotion = { moving: true, sprinting: false };
const SPRINT: AvatarMotion = { moving: true, sprinting: true };
const FRAME_MS = 1000 / 60;
const BUILD_SCALE: Readonly<Record<AvatarBuild, number>> = { small: 0.86, standard: 1, large: 1.14 };

function meshesOf(object: Object3D): Mesh[] {
  const found: Mesh[] = [];
  object.traverse((child) => {
    if (child instanceof Mesh) found.push(child);
  });
  return found;
}

function part(figure: AvatarFigure, name: string): Object3D {
  const found = figure.object.getObjectByName(name);
  if (!found) throw new Error(`figure has no ${name}`);
  return found;
}

function mesh(figure: AvatarFigure, name: string): Mesh {
  const found = part(figure, name);
  if (!(found instanceof Mesh)) throw new Error(`${name} is not a mesh`);
  return found;
}

function run(figure: AvatarFigure, frames: number, motion: AvatarMotion, frameMs = FRAME_MS): void {
  for (let frame = 0; frame < frames; frame += 1) figure.update(frameMs, motion);
}

/** Every local transform in the figure, flattened, for determinism and NaN checks. */
function transforms(object: Object3D): number[] {
  const values: number[] = [];
  object.traverse((child) => {
    values.push(...child.position.toArray(), child.rotation.x, child.rotation.y, child.rotation.z);
    values.push(...child.scale.toArray());
  });
  return values;
}

function legSwing(figure: AvatarFigure): number {
  return part(figure, 'avatar-leg-left-pivot').rotation.x;
}

afterEach(() => {
  disposeAvatarFigureCache();
});

describe('avatar figure shape', () => {
  it('stands on the ground at its build’s height, every small below every standard below every large', () => {
    const bands: Readonly<Record<AvatarBuild, readonly [number, number]>> = {
      small: [0.95, 1.1],
      standard: [1.2, 1.45],
      large: [1.5, 1.8],
    };
    const tops: Record<AvatarBuild, number[]> = { small: [], standard: [], large: [] };
    for (const key of AVATAR_SPRITE_KEYS) {
      const build = avatarLook(key).character.build;
      const bounds = new Box3().setFromObject(createAvatarFigure(key).object);
      expect(bounds.min.y, key).toBeGreaterThan(-0.001);
      expect(bounds.min.y, key).toBeLessThan(0.02);
      expect(bounds.max.y, key).toBeGreaterThanOrEqual(bands[build][0]);
      expect(bounds.max.y, key).toBeLessThanOrEqual(bands[build][1]);
      tops[build].push(bounds.max.y);
    }
    expect(Math.max(...tops.small)).toBeLessThan(Math.min(...tops.standard));
    expect(Math.max(...tops.standard)).toBeLessThan(Math.min(...tops.large));
  });

  it('scales the whole body uniformly per build, about the feet, leaving the root alone', () => {
    for (const key of AVATAR_SPRITE_KEYS) {
      const figure = createAvatarFigure(key);
      const body = part(figure, 'avatar-body');
      const scale = BUILD_SCALE[avatarLook(key).character.build];
      expect(body.parent, key).toBe(figure.object);
      expect(body.scale.toArray(), key).toEqual([scale, scale, scale]);
      expect(body.position.toArray(), key).toEqual([0, 0, 0]);
      expect(figure.object.scale.toArray(), key).toEqual([1, 1, 1]);
    }
    const torsoWidth = (key: AvatarSpriteKey): number => {
      const bounds = new Box3().setFromObject(mesh(createAvatarFigure(key), 'avatar-torso'));
      return bounds.max.x - bounds.min.x;
    };
    // Everyday small against standard: the small fighting look's pauldrons stand wider (D-096).
    expect(torsoWidth('avatar-6')).toBeLessThan(torsoWidth('avatar-2'));
    expect(torsoWidth('avatar-2')).toBeLessThan(torsoWidth('avatar-12'));
  });

  it('stays between the ground and AVATAR_FIGURE_HEIGHT in every pose, and the constant stays tight', () => {
    let tallest = 0;
    for (const key of AVATAR_SPRITE_KEYS) {
      const figure = createAvatarFigure(key);
      for (const motion of [IDLE, WALK, SPRINT]) {
        for (let frame = 0; frame < 60; frame += 1) {
          figure.update(FRAME_MS, motion);
          const bounds = new Box3().setFromObject(figure.object, true);
          tallest = Math.max(tallest, bounds.max.y);
          expect(bounds.max.y, key).toBeLessThanOrEqual(AVATAR_FIGURE_HEIGHT);
          expect(bounds.min.y, key).toBeGreaterThan(-0.001);
        }
      }
    }
    expect(tallest).toBeGreaterThan(AVATAR_FIGURE_HEIGHT - 0.06);
  });

  it('reports each look’s true standing top, build scale included, falling back for unknown keys', () => {
    for (const key of AVATAR_SPRITE_KEYS) {
      const height = avatarFigureHeight(key);
      const figure = createAvatarFigure(key);
      let highest = 0;
      // A full idle breath (~3.3 s): a standing figure never pokes above the top, and reaches it.
      for (let frame = 0; frame < 210; frame += 1) {
        figure.update(FRAME_MS, IDLE);
        const top = new Box3().setFromObject(figure.object, true).max.y;
        expect(top, key).toBeLessThanOrEqual(height + 1e-9);
        highest = Math.max(highest, top);
      }
      expect(height - highest, key).toBeLessThan(0.001);
    }
    expect(avatarFigureHeight('avatar-0' as AvatarSpriteKey)).toBe(avatarFigureHeight('avatar-1'));
  });

  it('faces +Z at yaw 0, and turns with the caller-owned yaw', () => {
    const eye = new Vector3();
    const headCentre = new Vector3();
    for (const key of AVATAR_SPRITE_KEYS) {
      const figure = createAvatarFigure(key);
      figure.object.updateMatrixWorld(true);
      part(figure, 'avatar-eyes').getWorldPosition(eye);
      new Box3().setFromObject(mesh(figure, 'avatar-head')).getCenter(headCentre);
      expect(eye.z, key).toBeGreaterThan(headCentre.z + 0.1);

      figure.object.rotation.y = Math.PI;
      figure.object.updateMatrixWorld(true);
      part(figure, 'avatar-eyes').getWorldPosition(eye);
      new Box3().setFromObject(mesh(figure, 'avatar-head')).getCenter(headCentre);
      expect(eye.z, key).toBeLessThan(headCentre.z - 0.1);
    }
  });

  it('uses at most 14 meshes, the same ones across looks and setLook round-trips', () => {
    const figure = createAvatarFigure('avatar-1');
    const original = meshesOf(figure.object);
    expect(original.length).toBeLessThanOrEqual(14);
    for (const key of AVATAR_SPRITE_KEYS) {
      figure.setLook(key);
      expect(meshesOf(figure.object), key).toEqual(original);
      figure.setLook('avatar-1');
      expect(meshesOf(figure.object), key).toEqual(original);
    }
    for (const found of meshesOf(figure.object)) {
      expect(original).toContain(found);
    }
  });

  it('keeps every look within 7 meshes and 1,100 triangles, its boxes recorded for the clipping check', () => {
    for (const key of AVATAR_SPRITE_KEYS) {
      const figure = createAvatarFigure(key);
      const meshes = meshesOf(figure.object);
      expect(meshes, key).toHaveLength(7);
      let triangles = 0;
      for (const found of meshes) {
        const count = found.geometry.getAttribute('position').count / 3;
        triangles += count;
        // The recorded boxes tile the geometry's triangles exactly, in order.
        const boxes = avatarPartBoxes(found.geometry);
        let next = 0;
        for (const box of boxes) {
          expect(box.first, `${key} ${found.name}`).toBe(next);
          next += box.count;
        }
        expect(next, `${key} ${found.name}`).toBe(count);
      }
      expect(triangles, key).toBeLessThanOrEqual(1100);
      figure.dispose();
    }
  });

  it('gives the cat girl (avatar-2 and avatar-10) her ears on the head and her tail on the torso, in both outfits', () => {
    const tags = (key: AvatarSpriteKey, name: string): string[] =>
      avatarPartBoxes(mesh(createAvatarFigure(key), name).geometry).map((box) => box.tag);
    for (const key of ['avatar-2', 'avatar-10'] as const) {
      // Two ears, each a fur block and an inner ear; they turn and nod with the head.
      expect(tags(key, 'avatar-head').filter((tag) => tag === 'ears'), key).toHaveLength(4);
      expect(tags(key, 'avatar-head'), key).toContain('face');
      expect(tags(key, 'avatar-torso').filter((tag) => tag === 'tail'), key).toHaveLength(4);
    }
    for (const key of AVATAR_SPRITE_KEYS.filter((k) => k !== 'avatar-2' && k !== 'avatar-10')) {
      expect(tags(key, 'avatar-head'), key).not.toContain('ears');
      expect(tags(key, 'avatar-torso'), key).not.toContain('tail');
    }
  });

  it('builds the battle outfits’ gear on the parts that carry it (D-096)', () => {
    const tags = (key: AvatarSpriteKey, name: string): string[] =>
      avatarPartBoxes(mesh(createAvatarFigure(key), name).geometry).map((box) => box.tag);
    // The swordsman: high collar and sheath on the torso, greaves on the legs, sword in hand.
    expect(tags('avatar-9', 'avatar-torso')).toEqual(expect.arrayContaining(['collar', 'sheath', 'coat-tail']));
    expect(tags('avatar-9', 'avatar-leg-left')).toContain('greave');
    expect(tags('avatar-9', 'avatar-arm-right')).toContain('sword');
    expect(tags('avatar-10', 'avatar-arm-right')).toContain('dagger');
    expect(tags('avatar-11', 'avatar-torso')).toContain('quiver');
    expect(tags('avatar-11', 'avatar-arm-right')).toContain('bow');
    expect(tags('avatar-14', 'avatar-arm-right')).toContain('hammer');
    expect(tags('avatar-16', 'avatar-leg-right')).toContain('greave');
    // Fingerless gloves show the fingers: a skin box at the end of each fist.
    const skin = avatarLook('avatar-9').character.skin;
    const arm = mesh(createAvatarFigure('avatar-9'), 'avatar-arm-left').geometry;
    const hands = avatarPartBoxes(arm).filter((box) => box.tag === 'hand');
    expect(hands).toHaveLength(2);
    const colours = arm.getAttribute('color');
    const fingers = hands[1]!.first * 3;
    const expected = new Color(skin);
    expect([colours.getX(fingers), colours.getY(fingers), colours.getZ(fingers)]).toEqual([
      expect.closeTo(expected.r, 5),
      expect.closeTo(expected.g, 5),
      expect.closeTo(expected.b, 5),
    ]);
    // Every cosy look is untouched: none of the new gear is worn day to day.
    for (const key of AVATAR_SPRITE_KEYS.slice(0, 8)) {
      for (const name of ['avatar-torso', 'avatar-leg-left', 'avatar-arm-left']) {
        for (const tag of ['collar', 'sheath', 'quiver', 'greave']) expect(tags(key, name), key).not.toContain(tag);
      }
    }
  });

  it('casts and receives shadows from every mesh', () => {
    const figure = createAvatarFigure('avatar-15');
    for (const found of meshesOf(figure.object)) {
      expect(found.castShadow, found.name).toBe(true);
      expect(found.receiveShadow, found.name).toBe(true);
    }
  });

  it('shares geometry per look and one material across all figures', () => {
    const first = createAvatarFigure('avatar-3');
    const second = createAvatarFigure('avatar-3');
    const other = createAvatarFigure('avatar-11');
    for (const name of ['avatar-head', 'avatar-torso', 'avatar-arm-left', 'avatar-arm-right', 'avatar-leg-left']) {
      expect(mesh(second, name).geometry, name).toBe(mesh(first, name).geometry);
    }
    expect(mesh(first, 'avatar-leg-right').geometry).toBe(mesh(first, 'avatar-leg-left').geometry);
    expect(mesh(other, 'avatar-arm-right').geometry).not.toBe(mesh(first, 'avatar-arm-right').geometry);
    expect(mesh(other, 'avatar-torso').material).toBe(mesh(first, 'avatar-head').material);
  });
});

describe('avatar figure looks', () => {
  it('validates keys from untyped callers', () => {
    const figure = createAvatarFigure('avatar-99' as AvatarSpriteKey);
    expect(figure.look).toBe('avatar-1');
    figure.setLook('avatar-6');
    figure.setLook('nonsense' as AvatarSpriteKey);
    expect(figure.look).toBe('avatar-1');
  });

  it('swaps looks in place, keeping the object identity the caller holds', () => {
    const figure = createAvatarFigure('avatar-2');
    const object = figure.object;
    const torso = mesh(figure, 'avatar-torso');
    const before = torso.geometry;
    figure.setLook('avatar-12');
    expect(figure.object).toBe(object);
    expect(figure.look).toBe('avatar-12');
    expect(mesh(figure, 'avatar-torso')).toBe(torso);
    expect(torso.geometry).not.toBe(before);
    figure.setLook('avatar-2');
    expect(torso.geometry).toBe(before);
  });

  it('applies the new build’s scale on setLook and keeps it across a cosy/fighting toggle', () => {
    const figure = createAvatarFigure('avatar-1');
    const object = figure.object;
    const body = part(figure, 'avatar-body');
    const meshes = meshesOf(object);
    const steps: ReadonlyArray<readonly [AvatarSpriteKey, number]> = [
      ['avatar-4', 1.14],
      ['avatar-12', 1.14],
      ['avatar-14', 0.86],
      ['avatar-6', 0.86],
      ['avatar-9', 1],
      ['avatar-15', 1.14],
    ];
    for (const [key, scale] of steps) {
      figure.setLook(key);
      expect(body.scale.toArray(), key).toEqual([scale, scale, scale]);
      expect(figure.object, key).toBe(object);
      expect(part(figure, 'avatar-body'), key).toBe(body);
      expect(meshesOf(object), key).toEqual(meshes);
      // The swapped figure stands on the ground within its look's breathing range.
      const bounds = new Box3().setFromObject(object, true);
      expect(bounds.min.y, key).toBeGreaterThan(-0.001);
      expect(bounds.max.y, key).toBeLessThanOrEqual(avatarFigureHeight(key) + 1e-9);
      expect(bounds.max.y, key).toBeGreaterThan(avatarFigureHeight(key) - 0.02);
    }
  });

  it('never moves, turns or scales the caller-owned root', () => {
    const figure = createAvatarFigure('avatar-7');
    figure.object.position.set(3, 0, 5);
    figure.object.rotation.set(0, 1.2, 0);
    run(figure, 30, SPRINT);
    figure.setLook('avatar-6');
    run(figure, 30, IDLE);
    expect(figure.object.position.toArray()).toEqual([3, 0, 5]);
    expect(figure.object.rotation.toArray().slice(0, 3)).toEqual([0, 1.2, 0]);
    expect(figure.object.scale.toArray()).toEqual([1, 1, 1]);
  });
});

describe('avatar figure animation', () => {
  it('survives zero, negative, NaN, infinite and huge deltas without NaN transforms', () => {
    const figure = createAvatarFigure('avatar-13');
    for (const delta of [0, -16, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 10_000]) {
      for (const motion of [IDLE, WALK, SPRINT]) {
        expect(() => figure.update(delta, motion)).not.toThrow();
        for (const value of transforms(figure.object)) {
          expect(Number.isFinite(value), `delta ${delta}`).toBe(true);
        }
      }
    }
    expect(() => figure.update(16, undefined as unknown as AvatarMotion)).not.toThrow();
    expect(transforms(figure.object).every(Number.isFinite)).toBe(true);
  });

  it('clamps a stalled frame to one short step', () => {
    const stalled = createAvatarFigure('avatar-1');
    const stepped = createAvatarFigure('avatar-1');
    run(stalled, 20, WALK);
    run(stepped, 20, WALK);
    stalled.update(10_000, WALK);
    stepped.update(100, WALK);
    expect(transforms(stalled.object)).toEqual(transforms(stepped.object));
  });

  it('swings legs and opposite arms when walking, and holds them still when idle', () => {
    const walker = createAvatarFigure('avatar-8');
    const idler = createAvatarFigure('avatar-8');
    let widest = 0;
    let opposed = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      walker.update(FRAME_MS, WALK);
      idler.update(FRAME_MS, IDLE);
      const leg = legSwing(walker);
      const arm = part(walker, 'avatar-arm-left-pivot').rotation.x;
      widest = Math.max(widest, Math.abs(leg));
      if (Math.abs(leg) > 0.1 && Math.sign(leg) === -Math.sign(arm)) opposed += 1;
      expect(Math.abs(legSwing(idler))).toBe(0);
      expect(Math.abs(part(idler, 'avatar-arm-left-pivot').rotation.x)).toBe(0);
    }
    expect(widest).toBeGreaterThan(0.45);
    expect(opposed).toBeGreaterThan(20);
    expect(part(walker, 'avatar-leg-right-pivot').rotation.x).toBeCloseTo(-legSwing(walker), 10);
  });

  it('sprints with a wider, faster stride and a forward lean', () => {
    const measure = (motion: AvatarMotion): { widest: number; crossings: number; lean: number } => {
      const figure = createAvatarFigure('avatar-1');
      run(figure, 30, motion);
      let widest = 0;
      let crossings = 0;
      let previous = legSwing(figure);
      for (let frame = 0; frame < 120; frame += 1) {
        figure.update(FRAME_MS, motion);
        const swing = legSwing(figure);
        widest = Math.max(widest, Math.abs(swing));
        if (Math.sign(swing) !== Math.sign(previous)) crossings += 1;
        previous = swing;
      }
      return { widest, crossings, lean: part(figure, 'avatar-upper-body').rotation.x };
    };
    const walk = measure(WALK);
    const sprint = measure(SPRINT);
    expect(sprint.widest).toBeGreaterThan(walk.widest + 0.15);
    expect(sprint.crossings).toBeGreaterThan(walk.crossings);
    expect(sprint.lean).toBeGreaterThan(walk.lean + 0.1);
  });

  it('blends between idle, walk and sprint without popping', () => {
    const figure = createAvatarFigure('avatar-5');
    const hips = part(figure, 'avatar-hips');
    const upper = part(figure, 'avatar-upper-body');
    let previous = { leg: legSwing(figure), lean: upper.rotation.x, hips: hips.position.y };
    let biggestLegStep = 0;
    let biggestLeanStep = 0;
    let biggestHipStep = 0;
    for (const motion of [WALK, IDLE, SPRINT, IDLE, WALK, SPRINT, WALK]) {
      for (let frame = 0; frame < 40; frame += 1) {
        figure.update(FRAME_MS, motion);
        const now = { leg: legSwing(figure), lean: upper.rotation.x, hips: hips.position.y };
        biggestLegStep = Math.max(biggestLegStep, Math.abs(now.leg - previous.leg));
        biggestLeanStep = Math.max(biggestLeanStep, Math.abs(now.lean - previous.lean));
        biggestHipStep = Math.max(biggestHipStep, Math.abs(now.hips - previous.hips));
        previous = now;
      }
    }
    // Full-speed sprint moves a leg ~0.22 rad per 60 Hz frame and eases the 0.2 rad
    // lean out over a few frames; a pop would jump the whole swing or lean at once.
    expect(biggestLegStep).toBeLessThan(0.3);
    expect(biggestLeanStep).toBeLessThan(0.08);
    // Rigid boots rock over heel and toe, so the hips kink at mid-stance (~0.033 per frame at a sprint).
    expect(biggestHipStep).toBeLessThan(0.04);
  });

  it('breathes and blinks when idle, deterministically', () => {
    const first = createAvatarFigure('avatar-6');
    const second = createAvatarFigure('avatar-6');
    const upper = part(first, 'avatar-upper-body');
    const eyes = part(first, 'avatar-eyes');
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let blinked = false;
    for (let frame = 0; frame < 300; frame += 1) {
      first.update(FRAME_MS, IDLE);
      second.update(FRAME_MS, IDLE);
      lowest = Math.min(lowest, upper.position.y);
      highest = Math.max(highest, upper.position.y);
      expect(eyes.scale.y).toBeGreaterThan(0);
      if (eyes.scale.y < 1) blinked = true;
    }
    expect(highest - lowest).toBeGreaterThan(0.005);
    expect(blinked).toBe(true);
    expect(transforms(first.object)).toEqual(transforms(second.object));
  });

  it('produces identical poses from identical inputs', () => {
    const first = createAvatarFigure('avatar-12');
    const second = createAvatarFigure('avatar-12');
    const script: ReadonlyArray<readonly [number, AvatarMotion]> = [
      [16, WALK], [33, WALK], [7, SPRINT], [250, SPRINT], [0, IDLE], [16, IDLE], [48, WALK],
    ];
    for (let round = 0; round < 5; round += 1) {
      for (const [delta, motion] of script) {
        first.update(delta, motion);
        second.update(delta, motion);
      }
    }
    expect(transforms(first.object)).toEqual(transforms(second.object));
  });
});

describe('avatar figure disposal', () => {
  it('is idempotent, detaches the figure and leaves shared resources alone', () => {
    const scene = new Group();
    const figure = createAvatarFigure('avatar-9');
    const survivor = createAvatarFigure('avatar-9');
    scene.add(figure.object, survivor.object);
    const torso = mesh(figure, 'avatar-torso');
    let disposals = 0;
    torso.geometry.addEventListener('dispose', () => {
      disposals += 1;
    });
    (torso.material as Material).addEventListener('dispose', () => {
      disposals += 1;
    });
    figure.dispose();
    expect(() => figure.dispose()).not.toThrow();
    expect(figure.object.parent).toBeNull();
    expect(survivor.object.parent).toBe(scene);
    expect(disposals).toBe(0);
    expect(mesh(survivor, 'avatar-torso').geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('turns later update and setLook calls into no-ops', () => {
    const figure = createAvatarFigure('avatar-4');
    run(figure, 20, WALK);
    const pose = transforms(figure.object);
    const geometry = mesh(figure, 'avatar-torso').geometry;
    figure.dispose();
    figure.update(100, SPRINT);
    figure.setLook('avatar-5');
    expect(figure.look).toBe('avatar-4');
    expect(transforms(figure.object)).toEqual(pose);
    expect(mesh(figure, 'avatar-torso').geometry).toBe(geometry);
  });

  it('releases the shared caches on engine teardown, and rebuilds them on demand', () => {
    const figure = createAvatarFigure('avatar-16');
    const geometry = mesh(figure, 'avatar-torso').geometry;
    const material = mesh(figure, 'avatar-torso').material as Material;
    const released: string[] = [];
    geometry.addEventListener('dispose', () => released.push('geometry'));
    material.addEventListener('dispose', () => released.push('material'));
    figure.dispose();
    disposeAvatarFigureCache();
    expect(released).toEqual(['geometry', 'material']);
    const rebuilt = createAvatarFigure('avatar-16');
    expect(mesh(rebuilt, 'avatar-torso').geometry).not.toBe(geometry);
    expect(mesh(rebuilt, 'avatar-torso').material).not.toBe(material);
  });
});
