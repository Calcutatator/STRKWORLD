import { describe, expect, it } from 'vitest';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  ShaderMaterial,
  Vector3,
} from 'three';
import {
  AFFORDANCE_CLOCK_WRAP_MS,
  AFFORDANCE_EMBER,
  AFFORDANCE_FADE_MS,
  AFFORDANCE_MAX_SLOTS,
  SHIMMER_FLOOR,
  SHIMMER_PEAK,
  SHIMMER_PERIOD_MS,
  SHIMMER_SLOT_PHASE,
  SHIMMER_STATIC,
  SHIMMER_SWEEP_AXIS,
  SHIMMER_SWEEP_PEAK,
  SHIMMER_SWEEP_PERIOD_MS,
  SHIMMER_TINT_LIGHTNESS,
  SHIMMER_TINT_MAX_SATURATION,
  SHIMMER_TINT_MIN_SATURATION,
  SHIMMER_TINT_WARM_HUE,
  advanceAffordanceClock,
  affordanceClock,
  createAffordanceShells,
  shimmerBase,
  shimmerSlotPhase,
  shimmerStrength,
  shimmerSweep,
} from './affordance.js';
import { GeometryBin } from './palette.js';

/**
 * D-123 (amended 2026-10-02): the affordance shells: one mesh per area, a slot
 * per usable thing, a colour-matched sweeping shimmer on every usable one and
 * an ember edge glow on the chosen one.
 */

const box = (x: number) => new BoxGeometry(1, 1, 1).translate(x, 0.5, 0);

/** A box wearing one baked vertex colour, the way a merged bin hands one over. */
function painted(x: number, hex: number, size = 1): BufferGeometry {
  const geometry = new BoxGeometry(size, size, size).translate(x, size / 2, 0);
  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** A shimmer colour as hue, saturation and lightness, the way the eye reads it. */
function hsl(hex: number): { h: number; s: number; l: number } {
  const out = { h: 0, s: 0, l: 0 };
  new Color().setHex(hex).getHSL(out, SRGBColorSpace);
  return out;
}

/** The hue of `hex` as the source paint, for comparing against a derived tint. */
const hueOf = (hex: number): number => hsl(hex).h;

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
    // Each piece twice (surface and band), tagged with its slot, where it sits
    // along the sweep (plus its slot's phase) and its own shimmer tint.
    const slot = set.mesh.geometry.getAttribute('aSlot');
    const band = set.mesh.geometry.getAttribute('aBand');
    expect(set.mesh.geometry.getAttribute('aSweep').itemSize).toBe(2);
    expect(set.mesh.geometry.getAttribute('aTint').itemSize).toBe(3);
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

  it('breathes slowly on one shared clock, and the clock wraps on both periods', () => {
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
    expect(ua['uTime']!.value).toBeCloseTo((before + 100) % AFFORDANCE_CLOCK_WRAP_MS);
    expect(ua['uMotion']!.value).toBe(1);
    // The wrap is whole breaths and whole glides, so neither jumps at it.
    expect(AFFORDANCE_CLOCK_WRAP_MS % SHIMMER_PERIOD_MS).toBe(0);
    expect(AFFORDANCE_CLOCK_WRAP_MS % SHIMMER_SWEEP_PERIOD_MS).toBe(0);
    // About 2.5 s a breath, lifting the surface 12% to 20%.
    expect(SHIMMER_PERIOD_MS).toBe(2500);
    expect(shimmerBase(0, false)).toBeCloseTo(SHIMMER_FLOOR);
    expect(shimmerBase(SHIMMER_PERIOD_MS / 2, false)).toBeCloseTo(SHIMMER_PEAK);
    expect(SHIMMER_FLOOR).toBeGreaterThanOrEqual(0.12);
    expect(SHIMMER_PEAK).toBeLessThanOrEqual(0.2);
    advanceAffordanceClock(0, false);
    a.dispose();
    b.dispose();
  });

  it('sweeps a soft band along each thing about every 3 s, on top of the breathe', () => {
    expect(SHIMMER_SWEEP_PERIOD_MS).toBe(3000);
    // The band enters off one end and leaves off the other: at the turn of a
    // glide nothing of the thing is lit by it, so there is no snap.
    expect(shimmerSweep(0, 0, false)).toBe(0);
    expect(shimmerSweep(0, 1, false)).toBe(0);
    // Its crest passes every point once a glide, and it is the loud part of
    // the cue: well above the breathe it rides on.
    const travel = (along: number): number => {
      let peak = 0;
      for (let t = 0; t < SHIMMER_SWEEP_PERIOD_MS; t += 10) peak = Math.max(peak, shimmerSweep(t, along, false));
      return peak;
    };
    for (const along of [0, 0.25, 0.5, 0.75, 1]) expect(travel(along)).toBeCloseTo(SHIMMER_SWEEP_PEAK, 2);
    expect(SHIMMER_SWEEP_PEAK).toBeGreaterThan(SHIMMER_PEAK);
    // It is a band, not a flash: at any moment only part of the thing is in it.
    const lit = [0, 0.2, 0.4, 0.6, 0.8, 1].filter((along) => shimmerSweep(900, along, false) > 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThan(6);
    // And it travels: the crest is further along later in the glide.
    const crestAt = (time: number): number => {
      let best = 0;
      let at = 0;
      for (let along = 0; along <= 1; along += 0.01) {
        const value = shimmerSweep(time, along, false);
        if (value > best) {
          best = value;
          at = along;
        }
      }
      return at;
    };
    expect(crestAt(2100)).toBeGreaterThan(crestAt(900));
  });

  it('holds still for reduced motion: no sweep, no breathe, a slightly stronger tint', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    const set = shells.build('area')!;
    const uniforms = (set.mesh.material as ShaderMaterial).uniforms;
    advanceAffordanceClock(16, true);
    expect(uniforms['uMotion']!.value).toBe(0);
    for (const time of [0, 700, SHIMMER_PERIOD_MS / 2, 2600]) {
      for (const along of [0, 0.5, 1]) {
        expect(shimmerSweep(time, along, true)).toBe(0);
        expect(shimmerStrength(time, along, true)).toBe(SHIMMER_STATIC);
      }
    }
    // Still discoverable: stronger than the moving cue's quietest moment.
    expect(SHIMMER_STATIC).toBeGreaterThan(SHIMMER_FLOOR);
    advanceAffordanceClock(0, false);
    set.dispose();
  });

  it('starts each slot further round the cycle, so a row never moves as one', () => {
    const shells = createAffordanceShells();
    shells.add('a', box(0));
    shells.add('b', box(3));
    shells.add('c', box(6));
    const set = shells.build('area')!;
    const slot = set.mesh.geometry.getAttribute('aSlot');
    const sweep = set.mesh.geometry.getAttribute('aSweep');
    const phases = new Map<number, Set<number>>();
    for (let i = 0; i < slot.count; i++) {
      const at = slot.getX(i);
      if (!phases.has(at)) phases.set(at, new Set());
      phases.get(at)!.add(Math.round(sweep.getY(i) * 1e6));
    }
    // One phase per slot, and three different ones.
    for (const set0 of phases.values()) expect(set0.size).toBe(1);
    expect(new Set([...phases.values()].map((s) => [...s][0])).size).toBe(3);
    for (const [at, values] of phases) expect([...values][0]! / 1e6).toBeCloseTo(shimmerSlotPhase(at), 5);
    expect(shimmerSlotPhase(0)).toBe(0);
    expect(shimmerSlotPhase(1)).toBeCloseTo(SHIMMER_SLOT_PHASE, 10);
    set.dispose();
  });

  it('measures the sweep over each thing\'s own extent, so one glide crosses any of them', () => {
    const shells = createAffordanceShells();
    // A one-tile figure and a six-tile desk in the same area.
    shells.add('figure', new BoxGeometry(1, 2, 1).translate(0, 1, 0));
    shells.add('desk', new BoxGeometry(6, 1, 1).translate(20, 0.5, 0));
    const set = shells.build('area')!;
    const slot = set.mesh.geometry.getAttribute('aSlot');
    const sweep = set.mesh.geometry.getAttribute('aSweep');
    const position = set.mesh.geometry.getAttribute('position');
    const span = [
      { min: Infinity, max: -Infinity },
      { min: Infinity, max: -Infinity },
    ];
    for (let i = 0; i < slot.count; i++) {
      const at = span[slot.getX(i)]!;
      at.min = Math.min(at.min, sweep.getX(i));
      at.max = Math.max(at.max, sweep.getX(i));
    }
    // Both run the full 0 to 1, whatever their size.
    for (const at of span) {
      expect(at.min).toBeCloseTo(0, 6);
      expect(at.max).toBeCloseTo(1, 6);
    }
    // And 0 really is the near end of the axis: the vertex furthest along it is 1.
    let furthest = -1;
    let along = -Infinity;
    for (let i = 0; i < slot.count; i++) {
      if (slot.getX(i) !== 0) continue;
      const dot = position.getX(i) * SHIMMER_SWEEP_AXIS.x + position.getY(i) * SHIMMER_SWEEP_AXIS.y + position.getZ(i) * SHIMMER_SWEEP_AXIS.z;
      if (dot > along) {
        along = dot;
        furthest = i;
      }
    }
    expect(sweep.getX(furthest)).toBeCloseTo(1, 6);
    set.dispose();
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

  it('takes each thing\'s shimmer colour from that thing\'s own colours', () => {
    const shells = createAffordanceShells();
    shells.add('gold', painted(0, 0xc9a227));
    shells.add('neon', painted(4, 0xff2fb8));
    shells.add('sky', painted(8, 0x2f7fff));
    const set = shells.build('area')!;
    // Each one its own hue, within a quantisation step of the paint it came from.
    expect(hsl(set.shimmerColor('gold')).h).toBeCloseTo(hueOf(0xc9a227), 1);
    expect(hsl(set.shimmerColor('neon')).h).toBeCloseTo(hueOf(0xff2fb8), 1);
    expect(hsl(set.shimmerColor('sky')).h).toBeCloseTo(hueOf(0x2f7fff), 1);
    // Three different tints, not one global ember.
    const tints = new Set(set.ids.map((id) => set.shimmerColor(id)));
    expect(tints.size).toBe(3);
    expect(tints.has(AFFORDANCE_EMBER)).toBe(false);
    set.dispose();
  });

  it('bakes that colour per vertex, so the whole area still costs one draw call', () => {
    const shells = createAffordanceShells();
    shells.add('gold', painted(0, 0xc9a227));
    shells.add('neon', painted(4, 0xff2fb8));
    const set = shells.build('area')!;
    const slot = set.mesh.geometry.getAttribute('aSlot');
    const tint = set.mesh.geometry.getAttribute('aTint');
    const expected = set.ids.map((id) => new Color().setHex(set.shimmerColor(id)));
    for (let i = 0; i < slot.count; i++) {
      const want = expected[slot.getX(i)]!;
      expect(tint.getX(i)).toBeCloseTo(want.r, 5);
      expect(tint.getY(i)).toBeCloseTo(want.g, 5);
      expect(tint.getZ(i)).toBeCloseTo(want.b, 5);
    }
    // One mesh, one material, whatever the colours.
    expect(set.mesh.material).toBeInstanceOf(ShaderMaterial);
    set.dispose();
  });

  it('lets a thin bright trim beat the dark bulk behind it (a gold-trimmed counter)', () => {
    const shells = createAffordanceShells();
    // The Bank's counter in miniature: a big near-black desk, a small gold trim.
    shells.add('counter', painted(0, 0x141414, 2));
    shells.add('counter', painted(3, 0xc9a227, 0.4));
    const set = shells.build('area')!;
    const tint = hsl(set.shimmerColor('counter'));
    expect(tint.h).toBeCloseTo(hueOf(0xc9a227), 1);
    expect(tint.s).toBeGreaterThan(SHIMMER_TINT_MIN_SATURATION);
    set.dispose();
  });

  it('gives a dark or colourless thing a visible pale warm tint, never a black one', () => {
    const shells = createAffordanceShells();
    shells.add('black', painted(0, 0x0a0a0a));
    shells.add('stone', painted(4, 0x8a8a8a));
    shells.add('nothing', box(8)); // no colours at all
    const set = shells.build('area')!;
    for (const id of ['black', 'stone', 'nothing']) {
      const tint = hsl(set.shimmerColor(id));
      expect(tint.h).toBeCloseTo(SHIMMER_TINT_WARM_HUE, 2);
      expect(tint.s).toBeCloseTo(SHIMMER_TINT_MIN_SATURATION, 2);
      expect(tint.l).toBeCloseTo(SHIMMER_TINT_LIGHTNESS, 2);
      // Visible: nowhere near black, whatever the thing is painted.
      expect(new Color().setHex(set.shimmerColor(id)).getHexString()).not.toBe('000000');
    }
    set.dispose();
  });

  it('lifts every tint to one lightness and caps neon, so no station shouts over the rest', () => {
    const shells = createAffordanceShells();
    shells.add('dim', painted(0, 0x24160a));
    shells.add('neon', painted(4, 0x00ffd5));
    const set = shells.build('area')!;
    for (const id of set.ids) {
      const tint = hsl(set.shimmerColor(id));
      expect(tint.l).toBeCloseTo(SHIMMER_TINT_LIGHTNESS, 2);
      expect(tint.s).toBeLessThanOrEqual(SHIMMER_TINT_MAX_SATURATION + 0.01);
    }
    // The neon one still reads as neon, not washed to the warm fallback.
    expect(hsl(set.shimmerColor('neon')).s).toBeCloseTo(SHIMMER_TINT_MAX_SATURATION, 2);
    expect(hsl(set.shimmerColor('neon')).h).toBeCloseTo(hueOf(0x00ffd5), 1);
    set.dispose();
  });

  it('reads the colour a builder asked its bin for, and a mesh\'s material when there is none', () => {
    const shells = createAffordanceShells();
    const bin = new GeometryBin();
    // A recorded piece has no vertex colours yet: the paint is the only source.
    shells.record('desk', bin).add('body', box(0), 0x1a73e8);
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xd93f87 })));
    shells.addObject('plain', group, group);
    const set = shells.build('area')!;
    expect(hsl(set.shimmerColor('desk')).h).toBeCloseTo(hueOf(0x1a73e8), 1);
    expect(hsl(set.shimmerColor('plain')).h).toBeCloseTo(hueOf(0xd93f87), 1);
    bin.dispose();
    set.dispose();
  });

  it('keeps the chosen target\'s edge glow ember, whatever the thing shimmers', () => {
    const shells = createAffordanceShells();
    shells.add('neon', painted(0, 0x00ffd5));
    const set = shells.build('area')!;
    const uniforms = (set.mesh.material as ShaderMaterial).uniforms;
    // The glow's colour is the brand's, and the shimmer's is the thing's.
    expect((uniforms['uColor']!.value as Color).getHex()).toBe(AFFORDANCE_EMBER);
    expect(set.shimmerColor('neon')).not.toBe(AFFORDANCE_EMBER);
    // And the two never show at once: the shimmer cross-fades out of the way.
    set.setUsable('neon', true);
    set.focus('neon');
    set.update(AFFORDANCE_FADE_MS);
    expect(set.shimmerLevel('neon')).toBe(0);
    expect(set.glowLevel('neon')).toBe(1);
    set.dispose();
  });

  it('gives a locked thing no colour to shimmer in and nothing to glow with', () => {
    const shells = createAffordanceShells();
    shells.add('locked', painted(0, 0xff2fb8));
    const set = shells.build('area')!;
    // It has a tint baked (unlocking must not rebuild geometry), but no level.
    expect(set.shimmerColor('locked')).not.toBe(0);
    expect(set.shimmerLevel('locked')).toBe(0);
    expect(set.glowLevel('locked')).toBe(0);
    expect(set.mesh.visible).toBe(false);
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
