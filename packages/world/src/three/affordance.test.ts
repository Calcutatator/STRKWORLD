import { describe, expect, it } from 'vitest';
import { AdditiveBlending, BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, ShaderMaterial, Vector3 } from 'three';
import {
  AFFORDANCE_EMBER,
  AFFORDANCE_FADE_MS,
  AFFORDANCE_MAX_SLOTS,
  SHIMMER_FLOOR,
  SHIMMER_PEAK,
  SHIMMER_PERIOD_MS,
  SHIMMER_STATIC,
  advanceAffordanceClock,
  affordanceClock,
  createAffordanceShells,
  shimmerStrength,
} from './affordance.js';
import { GeometryBin } from './palette.js';

/**
 * D-123: the affordance shells: one mesh per area, a slot per usable thing,
 * a faint shimmer on every usable one and an edge glow on the chosen one.
 */

const box = (x: number) => new BoxGeometry(1, 1, 1).translate(x, 0.5, 0);

describe('affordance shells (D-123)', () => {
  it('merges every thing in an area into one additive mesh: one draw call', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    shells.add('b', box(3));
    shells.add('b', box(4));
    const set = shells.build('area:affordances')!;
    expect(set.ids).toEqual(['a', 'b']);
    expect(set.mesh.name).toBe('area:affordances');
    const material = set.mesh.material as ShaderMaterial;
    expect(material.blending).toBe(AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    expect((material.uniforms['uColor']!.value as { getHex(): number }).getHex()).toBe(AFFORDANCE_EMBER);
    // Each piece twice (surface and band), tagged with its slot.
    const slot = set.mesh.geometry.getAttribute('aSlot');
    const band = set.mesh.geometry.getAttribute('aBand');
    expect(slot.count).toBe(36 * 3 * 2);
    const tally = (s: number, b: number) => Array.from({ length: slot.count }, (_, i) => i).filter((i) => slot.getX(i) === s && band.getX(i) === b).length;
    expect([tally(0, 0), tally(0, 1), tally(1, 0), tally(1, 1)]).toEqual([36, 36, 72, 72]);
    set.dispose();
  });

  it('builds nothing from nothing', () => {
    const shells = createAffordanceShells();
    shells.declare('a');
    expect(shells.build('empty')).toBeNull();
  });

  it('grows a box along its corners, so its band stays a closed box', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    const set = shells.build('area')!;
    const grow = set.mesh.geometry.getAttribute('aGrow');
    const position = set.mesh.geometry.getAttribute('position');
    for (let i = 0; i < 36; i++) {
      // Every corner of a unit box centred on (0, 0.5, 0) points outward on all three axes.
      expect(grow.getX(i)).toBe(Math.sign(position.getX(i)));
      expect(grow.getY(i)).toBe(Math.sign(position.getY(i) - 0.5));
      expect(grow.getZ(i)).toBe(Math.sign(position.getZ(i)));
    }
    set.dispose();
  });

  it('records a builder\'s pieces as they go into its bin, but never its glass', () => {
    const shells = createAffordanceShells();
    const bin = new GeometryBin();
    const recording = shells.record('desk', bin, (geometry) => {
      geometry.computeBoundingBox();
      return geometry.boundingBox!.max.x < 10;
    });
    recording.add('body', box(0), 0xffffff);
    recording.add('glass', box(1), 0xffffff);
    recording.add('body', box(20), 0xffffff);
    // The bin got all three, as if nothing were recording.
    expect(bin.has('body')).toBe(true);
    expect(bin.has('glass')).toBe(true);
    const set = shells.build('area')!;
    // The shell only the one on the footprint, and no glass.
    expect(set.mesh.geometry.getAttribute('aSlot').count).toBe(36 * 2);
    bin.dispose();
    set.dispose();
  });

  it('copies an object\'s meshes as they stand, an instanced mesh instance by instance', () => {
    const group = new Group();
    group.position.set(5, 0, 5);
    const leaves = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    leaves.setMatrixAt(0, new Matrix4().makeTranslation(-2, 0, 0));
    leaves.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    group.add(leaves, new Mesh(new BoxGeometry(1, 3, 1), new MeshBasicMaterial()));
    const shells = createAffordanceShells();
    shells.addObject('gate', group, group);
    const set = shells.build('gate')!;
    set.mesh.geometry.computeBoundingBox();
    const bounds = set.mesh.geometry.boundingBox!;
    expect(bounds.min.x).toBeCloseTo(-2.5);
    expect(bounds.max.x).toBeCloseTo(2.5);
    expect(bounds.max.y).toBeCloseTo(1.5);
    set.dispose();
  });

  it('caps the slots an area holds', () => {
    const shells = createAffordanceShells();
    for (let i = 0; i < AFFORDANCE_MAX_SLOTS; i++) shells.declare(`s${i}`);
    expect(() => shells.declare('one-too-many')).toThrow();
  });

  it('shimmers what is usable, glows only the chosen target, and fades it over about 200 ms', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    shells.add('b', box(3));
    const set = shells.build('area')!;
    // Nothing usable: hidden, so it costs no draw call.
    expect(set.mesh.visible).toBe(false);
    set.setUsable('a', true);
    set.setUsable('b', true);
    expect(set.mesh.visible).toBe(true);
    expect([set.shimmerLevel('a'), set.shimmerLevel('b')]).toEqual([1, 1]);
    set.focus('a');
    set.update(AFFORDANCE_FADE_MS / 2);
    expect(set.glowLevel('a')).toBeCloseTo(0.5);
    // The shimmer cross-fades into the glow.
    expect(set.shimmerLevel('a')).toBeCloseTo(0.5);
    set.update(AFFORDANCE_FADE_MS);
    expect(set.glowLevel('a')).toBe(1);
    expect(set.shimmerLevel('a')).toBe(0);
    expect(set.glowLevel('b')).toBe(0);
    set.focus(null);
    set.update(AFFORDANCE_FADE_MS);
    expect(set.glowLevel('a')).toBe(0);
    expect(set.shimmerLevel('a')).toBe(1);
    set.dispose();
  });

  it('never glows what is not usable (a locked counter), and drops a glow the moment it locks', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    const set = shells.build('area')!;
    set.focus('a');
    set.update(AFFORDANCE_FADE_MS);
    expect(set.glowLevel('a')).toBe(0);
    expect(set.focused).toBeNull();
    set.setUsable('a', true);
    set.focus('a');
    set.update(AFFORDANCE_FADE_MS);
    expect(set.glowLevel('a')).toBe(1);
    set.setUsable('a', false);
    expect(set.glowLevel('a')).toBe(0);
    expect(set.shimmerLevel('a')).toBe(0);
    expect(set.mesh.visible).toBe(false);
    set.dispose();
  });

  it('pulses slowly on one shared clock, a few percent, and holds still for reduced motion', () => {
    const one = createAffordanceShells();
    one.add('a', box(0));
    const two = createAffordanceShells();
    two.add('b', box(0));
    const a = one.build('a')!;
    const b = two.build('b')!;
    const ua = (a.mesh.material as ShaderMaterial).uniforms;
    const ub = (b.mesh.material as ShaderMaterial).uniforms;
    // The same uniform objects: one write a frame drives every shell.
    expect(ua['uTime']).toBe(ub['uTime']);
    expect(ua['uMotion']).toBe(ub['uMotion']);
    const before = affordanceClock().time;
    advanceAffordanceClock(100, false);
    expect(ua['uTime']!.value).toBeCloseTo((before + 100) % (SHIMMER_PERIOD_MS * 64));
    expect(ua['uMotion']!.value).toBe(1);
    // About 2.5 s a breath, between a floor and a peak of a few percent.
    expect(SHIMMER_PERIOD_MS).toBe(2500);
    expect(shimmerStrength(0, false)).toBeCloseTo(SHIMMER_FLOOR);
    expect(shimmerStrength(SHIMMER_PERIOD_MS / 2, false)).toBeCloseTo(SHIMMER_PEAK);
    expect(SHIMMER_PEAK).toBeLessThanOrEqual(0.1);
    // Reduced motion: a still, faint tint.
    advanceAffordanceClock(16, true);
    expect(ua['uMotion']!.value).toBe(0);
    expect(shimmerStrength(0, true)).toBe(SHIMMER_STATIC);
    expect(shimmerStrength(SHIMMER_PERIOD_MS / 2, true)).toBe(SHIMMER_STATIC);
    advanceAffordanceClock(0, false);
    a.dispose();
    b.dispose();
  });

  it('updates without allocating: levels live in one typed array the uniform reads', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    const set = shells.build('area')!;
    const uniform = (set.mesh.material as ShaderMaterial).uniforms['uSlots']!;
    const array = uniform.value as Float32Array;
    set.setUsable('a', true);
    set.focus('a');
    set.update(50);
    expect(uniform.value).toBe(array);
    expect(array[1]).toBeCloseTo(50 / AFFORDANCE_FADE_MS);
    set.dispose();
  });

  it('keeps its band inside the culling sphere', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    const set = shells.build('area')!;
    const sphere = set.mesh.geometry.boundingSphere!;
    const corner = new Vector3(0.5, 1, 0.5);
    expect(sphere.center.distanceTo(corner)).toBeLessThan(sphere.radius - 0.05);
    set.dispose();
  });
});
