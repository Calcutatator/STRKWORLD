import { describe, expect, it } from 'vitest';
import { Box3, Color, Mesh } from 'three';
import { GeometryBin } from './palette.js';
import { createSouthVista } from './south-vista.js';
import { SKY_HORIZON, SKY_TOP, skyColourAt } from './sky.js';
import { fogRange } from './world-engine.js';
import { EXCHANGE_ROOF_HEIGHT } from '../fixed-room.js';
import {
  CLOCK_DIAL,
  CLOCK_HEIGHT,
  CLOCK_OFFSET_X,
  CLOCK_ROOF,
  CLOCK_STONE,
  LATTICE_HEIGHT,
  LATTICE_IRON,
  LATTICE_OFFSET_X,
  laySouthLandmarks,
  type LandmarkPaint,
} from './south-landmarks.js';

/**
 * D-133 (2026-10-03): the skyline the swing looks at.
 *
 * The lead's words were that the view straight ahead "is just grey only". So
 * two things are pinned here: there are two landmarks on the far skyline,
 * standing either side of the swing's line of sight and costing one draw call
 * between them; and the vista they stand in is painted in colours, not in
 * greys — the thing that made the whole view read as weather.
 */

const MESHES = (root: { traverse(fn: (object: unknown) => void): void }): Mesh[] => {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
};

/** How colourful a colour is: HSL saturation, 0 is a grey. */
function saturation(hex: number): number {
  const hsl = { h: 0, s: 0, l: 0 };
  new Color(hex).getHSL(hsl);
  return hsl.s;
}

describe('the skyline landmarks (D-133)', () => {
  it('builds two towers into one bin, so the pair is one draw call', () => {
    const bin = new GeometryBin();
    try {
      laySouthLandmarks(bin, 'landmark', (colour) => () => new Color(colour), {
        centreX: 0,
        groundY: 1,
      });
      const geometry = bin.take('landmark');
      expect(geometry, 'both towers merged into the one bin').not.toBeNull();
      const box = new Box3().setFromBufferAttribute(geometry!.getAttribute('position') as never);
      // One to each side of the line of sight, framing what is between them.
      expect(box.min.x).toBeLessThan(LATTICE_OFFSET_X);
      expect(box.max.x).toBeGreaterThan(CLOCK_OFFSET_X);
      // The lattice tower is the taller of the two, by a good margin.
      expect(LATTICE_HEIGHT).toBeGreaterThan(CLOCK_HEIGHT * 1.4);
      expect(box.max.y).toBeGreaterThan(LATTICE_HEIGHT);
      geometry!.dispose();
    } finally {
      bin.dispose();
    }
  });

  it('stands in the vista as one extra mesh, in high quality and low', () => {
    for (const quality of ['high', 'low'] as const) {
      const vista = createSouthVista({ quality });
      const landmarks = MESHES(vista.group).filter((mesh) => mesh.name === 'south-vista:landmarks');
      expect(landmarks, quality).toHaveLength(1);
      const box = new Box3().setFromObject(landmarks[0]!);
      // Due south of the swing and well past the station, in the city.
      expect(box.min.z, quality).toBeGreaterThan(140);
      expect(box.max.y, quality).toBeGreaterThan(40);
      vista.dispose();
    }
  });

  it('is cheaper on a phone, and still both towers', () => {
    const high = new GeometryBin();
    const low = new GeometryBin();
    try {
      const paint: LandmarkPaint = (colour) => () => new Color(colour);
      laySouthLandmarks(high, 'landmark', paint, { centreX: 0, groundY: 1, quality: 'high' });
      laySouthLandmarks(low, 'landmark', paint, { centreX: 0, groundY: 1, quality: 'low' });
      const a = high.take('landmark')!;
      const b = low.take('landmark')!;
      expect(b.getAttribute('position').count).toBeLessThan(a.getAttribute('position').count);
      // Low quality still reaches both sides: neither tower is dropped.
      const box = new Box3().setFromBufferAttribute(b.getAttribute('position') as never);
      expect(box.min.x).toBeLessThan(LATTICE_OFFSET_X);
      expect(box.max.x).toBeGreaterThan(CLOCK_OFFSET_X);
      a.dispose();
      b.dispose();
    } finally {
      high.dispose();
      low.dispose();
    }
  });

  it('is painted, not grey: iron, warm stone, a green roof and a gold dial', () => {
    for (const [name, colour] of [
      ['iron', LATTICE_IRON],
      ['stone', CLOCK_STONE],
      ['roof', CLOCK_ROOF],
      ['dial', CLOCK_DIAL],
    ] as const) {
      expect(saturation(colour), name).toBeGreaterThan(0.2);
    }
  });
});

describe('the view south has colour in it (D-133)', () => {
  it('paints the water, the stone and the trees rather than greying them', () => {
    const vista = createSouthVista({ quality: 'high' });
    const colours = new Map<string, { saturated: number; total: number }>();
    for (const mesh of MESHES(vista.group)) {
      const attribute = mesh.geometry.getAttribute('color');
      if (!attribute) continue;
      const tally = { saturated: 0, total: 0 };
      const hsl = { h: 0, s: 0, l: 0 };
      const colour = new Color();
      for (let i = 0; i < attribute.count; i += 1) {
        colour.setRGB(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
        colour.getHSL(hsl);
        tally.total += 1;
        if (hsl.s > 0.12) tally.saturated += 1;
      }
      colours.set(mesh.name, tally);
    }
    for (const name of ['south-vista:water', 'south-vista:banks', 'south-vista:city', 'south-vista:landmarks']) {
      const tally = colours.get(name)!;
      expect(tally, name).toBeDefined();
      // Most of what the rider looks at has a colour, not a grey level.
      expect(tally.saturated / tally.total, name).toBeGreaterThan(0.5);
    }
    vista.dispose();
  });

  it('keeps the sky a golden-hour gradient with blue in it', () => {
    // The dome is the brand's own Sky and Horizon (D-113): blue above, warm
    // at the horizon. Neither is a grey, and they are not the same colour.
    expect(saturation(SKY_TOP)).toBeGreaterThan(0.3);
    expect(saturation(SKY_HORIZON)).toBeGreaterThan(0.3);
    const top = new Color(SKY_TOP);
    const horizon = new Color(SKY_HORIZON);
    expect(top.b).toBeGreaterThan(top.r);
    expect(horizon.r).toBeGreaterThan(horizon.b);
  });

  it('never passes through grey on the way up (amended 2026-10-03)', () => {
    // The lead, on the second look: "the upper sky still reads pale
    // grey-lavender". The two ends were never the problem — the *crossfade*
    // was. A warm cream mixed straight into a cool blue goes through a
    // neutral, and that neutral band was most of any shallow shot's frame.
    // The gradient now goes warm → gold → peach → rose → blue, which is what
    // a low sun does, and no step of it is a grey.
    let worst = { height: 0, saturation: 1 };
    for (let step = 0; step <= 100; step += 1) {
      const height = step / 100;
      const value = saturation(skyColourAt(height).getHex());
      if (value < worst.saturation) worst = { height, saturation: value };
    }
    expect(worst.saturation, `at h=${worst.height}`).toBeGreaterThan(0.2);
    // The straight two-stop crossfade it replaced does not clear that bar:
    // it bottoms out six times lower, which is the grey the lead saw.
    let before = 1;
    for (let step = 0; step <= 100; step += 1) {
      const mixed = new Color(SKY_HORIZON).lerp(new Color(SKY_TOP), Math.pow(step / 100, 0.55));
      before = Math.min(before, saturation(mixed.getHex()));
    }
    expect(before).toBeLessThan(worst.saturation / 4);
  });

  it('is gold at the horizon and a real blue overhead', () => {
    const low = skyColourAt(0.02);
    const high = skyColourAt(1);
    expect(low.r).toBeGreaterThan(low.b);
    expect(high.b).toBeGreaterThan(high.r);
    // Straight up is the brand's Sky itself, so the game and the title screen
    // stand under the same sky (D-113).
    expect(high.getHex()).toBe(new Color(SKY_TOP).getHex());
    // And below the horizon is still the cloud sea, not a second blue.
    expect(skyColourAt(-0.8).b).toBeLessThan(skyColourAt(-0.8).r);
  });
});

describe('the fog leaves the skyline alone (D-133)', () => {
  it('pushes the fog past the landmarks while the ride\'s shot is running', () => {
    // The vista bakes its own haze and opts out of the engine's fog, but the
    // fog still has to reach past the far bank or the clear air would end in
    // a wall. The ride's range covers the towers from the roof deck.
    const normal = fogRange(EXCHANGE_ROOF_HEIGHT, false);
    const riding = fogRange(EXCHANGE_ROOF_HEIGHT, true);
    expect(riding.far).toBeGreaterThan(normal.far);
    // The towers stand about 160 units south of the deck.
    expect(riding.far).toBeGreaterThan(160);
    expect(riding.near).toBeGreaterThan(normal.near - 1);
  });
});
