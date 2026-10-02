import { Color, type Group } from 'three';
import { BUNKER_DOOR, BUNKER_STAIRWELL, BUNKER_VENDING } from '../map/bunker.js';
import type { DistrictMap } from '../map/street.js';
import {
  GeometryBin,
  ResourceBag,
  beamGeometry,
  boxGeometry,
  clamp01,
  coneGeometry,
  cylinderGeometry,
  faceBox,
  faceQuad,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  mixHex,
  shade,
  standardMaterial,
  unlitMaterial,
  type Face,
} from './palette.js';

/**
 * The hidden stair in 3D (D-107): a narrow concrete service stair cut into
 * the alley mouth between the Bank and the Exchange, a steel door ajar at its
 * foot with neon leaking out and up the steps, a lit vending machine beside
 * it, and a calico cat asleep on the machine. Nothing here is text: no sign,
 * no label, no name. The one hint is a small sticker on the machine and a
 * stencilled arrow on the top step, both shapes.
 *
 * Presentation only, under the street's rule: the flight, the door and the
 * machine stand on solid `service` tiles; over the walkable top step there is
 * only the flush slab, flat decals and what lies below the ground (the first
 * steps down). Three draw calls: lit, self-lit and the additive neon spill,
 * which breathes slowly like the Studio arch's glow.
 */

export interface BunkerParts {
  /** `street:ground`: everything here. */
  readonly ground: Group;
  readonly animators: Array<(elapsedMs: number) => void>;
  /** Height of the walking surface on the top step: level with the pavement. */
  readonly floorHeight: number;
}

/** The neon leaking out of the door: magenta, and the cyan of the room's signs. */
export const BUNKER_NEON = Object.freeze({ magenta: 0xff3fa4, cyan: 0x3ff0ff });

const CONCRETE = 0x77716b;
const CONCRETE_DARK = 0x4a4643;
const STEEL = 0x8c9399;
const DOOR = 0x3f4b49;

/** How far the flight goes down, and where the steps begin on the top step's tile. */
const DEPTH = 1.1;
const STAIR_TOP_Z = BUNKER_DOOR.y + 0.6;
const STEPS = 6;
/** The service door's opening: its sides, and its head just above the ground. */
const DOOR_X0 = BUNKER_DOOR.x + 0.2;
const DOOR_X1 = BUNKER_DOOR.x + 0.8;
const DOOR_TOP = 0.32;

export function buildBunkerEntrance(map: DistrictMap, res: ResourceBag, parts: BunkerParts): void {
  // A map without the stair (a test district) builds nothing.
  if (map.tiles[BUNKER_DOOR.y]?.[BUNKER_DOOR.x] !== 'stairhead') return;
  const bin = new GeometryBin();
  try {
    stairwell(bin, parts.floorHeight);
    serviceDoor(bin);
    vendingMachine(bin, parts.floorHeight);
    sleepingCat(bin, BUNKER_VENDING.x + 0.5, VENDING_TOP, BUNKER_VENDING.y + 0.48);
    const lit = res.material(standardMaterial({ roughness: 0.82 }));
    flushBin(bin, 'body', lit, res, parts.ground, { name: 'street:hidden-stair', cast: true, receive: true });
    const glow = res.material(unlitMaterial());
    flushBin(bin, 'glow', glow, res, parts.ground, { name: 'street:hidden-stair-lights' });
    const spill = res.material(unlitMaterial({ additive: true }));
    flushBin(bin, 'light', spill, res, parts.ground, { name: 'street:hidden-stair-glow', renderOrder: 2 });
    parts.animators.push((elapsed) => {
      // A slow breath, never a strobe.
      spill.opacity = 0.78 + 0.22 * Math.sin((elapsed / 1000) * 0.9);
    });
  } finally {
    bin.dispose();
  }
}

// ---------------------------------------------------------------------------
// The stair
// ---------------------------------------------------------------------------

function stairwell(bin: GeometryBin, floor: number): void {
  const x0 = BUNKER_DOOR.x;
  const x1 = x0 + 1;
  const w0 = x0 + 0.12;
  const w1 = x1 - 0.12;
  const north = BUNKER_STAIRWELL.y + 0.1;
  const south = BUNKER_DOOR.y + 1;
  const bottom = -DEPTH;
  const wall = (y: number): Color => shade(CONCRETE, -0.18 * clamp01(-y / DEPTH));

  // The top step: a worn concrete slab flush with the pavement, its nosing
  // painted a tired yellow, and a faded pink arrow stencilled on it, pointing
  // down the screen: the one cryptic mark, a "↓".
  bin.add('body', boxGeometry(x0, -0.02, STAIR_TOP_Z, x1, floor, south), shade(CONCRETE, 0.04));
  bin.add('body', flatQuad(w0, STAIR_TOP_Z, w1, STAIR_TOP_Z + 0.06, floor + 0.003), 0xb8a046);
  const cx = (x0 + x1) / 2;
  const az = STAIR_TOP_Z + 0.26;
  const faded = mixHex(BUNKER_NEON.magenta, CONCRETE, 0.45);
  bin.add('body', flatPolygon([[cx - 0.08, az], [cx + 0.08, az], [cx, az + 0.1]], floor + 0.004), faded);
  bin.add('body', flatQuad(cx - 0.022, az - 0.1, cx + 0.022, az, floor + 0.004), faded);
  // Coping round the opening, flush, on the stair's own tiles.
  bin.add('body', flatQuad(x0, north - 0.1, x1, north, 0.012), CONCRETE_DARK);
  bin.add('body', flatQuad(x0, north, w0, STAIR_TOP_Z, 0.012), CONCRETE_DARK);
  bin.add('body', flatQuad(w1, north, x1, STAIR_TOP_Z, 0.012), CONCRETE_DARK);

  // The cut: two side walls and the head wall, below the ground.
  bin.add('body', boxGeometry(x0, bottom - 0.05, north, w0, 0.01, STAIR_TOP_Z), wall);
  bin.add('body', boxGeometry(w1, bottom - 0.05, north, x1, 0.01, STAIR_TOP_Z), wall);
  bin.add('body', boxGeometry(x0, bottom - 0.05, north - 0.1, x1, 0.01, north), wall);
  // Under the top step's slab, so the opening never shows the sky through it.
  bin.add('body', boxGeometry(w0, bottom - 0.05, STAIR_TOP_Z - 0.02, w1, floor - 0.001, STAIR_TOP_Z + 0.02), wall);

  // Six steps down to a small landing at the door.
  const landing = north + 0.42;
  const run = (STAIR_TOP_Z - landing) / STEPS;
  const rise = DEPTH / STEPS;
  for (let i = 0; i < STEPS; i++) {
    const top = -rise * (i + 1);
    const z1 = STAIR_TOP_Z - run * i;
    const z0 = z1 - run;
    bin.add('body', boxGeometry(w0, bottom - 0.05, z0, w1, top, z1), shade(CONCRETE, -0.05 - 0.02 * i));
    bin.add('body', boxGeometry(w0 + 0.01, top, z0 - 0.002, w1 - 0.01, top + 0.012, z0 + 0.03), 0x9c8a3e);
  }
  bin.add('body', boxGeometry(w0, bottom - 0.05, north, w1, bottom, landing), shade(CONCRETE, -0.2));

  // The head wall stands a little out of the ground round the door's head,
  // with a small hood, and a pipe railing guards the east side of the drop.
  const head = shade(CONCRETE, -0.04);
  bin.add('body', boxGeometry(x0 + 0.04, 0, north - 0.1, DOOR_X0 - 0.05, 0.52, north + 0.02), head);
  bin.add('body', boxGeometry(DOOR_X1 + 0.05, 0, north - 0.1, x1 - 0.04, 0.52, north + 0.02), head);
  bin.add('body', boxGeometry(DOOR_X0 - 0.05, DOOR_TOP + 0.05, north - 0.1, DOOR_X1 + 0.05, 0.52, north + 0.02), head);
  bin.add('body', boxGeometry(x0 + 0.02, 0.52, north - 0.1, x1 - 0.02, 0.58, north + 0.18), CONCRETE_DARK);
  const rx = x1 - 0.06;
  const r0 = north + 0.06;
  const r1 = BUNKER_STAIRWELL.y + 0.96;
  for (const z of [r0, (r0 + r1) / 2, r1]) bin.add('body', cylinderGeometry(rx, 0, z, 0.022, 0.022, 0.88, 6), STEEL);
  bin.add('body', beamGeometry([rx, 0.88, r0], [rx, 0.88, r1], 0.045), STEEL);
  bin.add('body', beamGeometry([rx, 0.46, r0], [rx, 0.46, r1], 0.03), STEEL);
  // A dead lamp cage on the hood.
  bin.add('body', boxGeometry(cx - 0.07, 0.42, north + 0.18, cx + 0.07, 0.5, north + 0.24), shade(STEEL, -0.25));
}

/**
 * The steel service door at the foot of the stair, ajar on its west hinge,
 * and the room's neon behind it: a lit slot, light on the landing and the
 * steps, and a faint wash rising out of the cut that the street can see.
 */
function serviceDoor(bin: GeometryBin): void {
  const x0 = DOOR_X0;
  const x1 = DOOR_X1;
  const plane = BUNKER_STAIRWELL.y + 0.1;
  const face: Face = { normal: 'z+', plane };
  const bottom = -DEPTH;
  const top = DOOR_TOP;
  // Frame, and the lit gap the half-open leaf leaves.
  bin.add('body', faceBox(face, x0 - 0.05, bottom, 0, x0, top + 0.05, 0.05), shade(STEEL, -0.3));
  bin.add('body', faceBox(face, x1, bottom, 0, x1 + 0.05, top + 0.05, 0.05), shade(STEEL, -0.3));
  bin.add('body', faceBox(face, x0 - 0.05, top, 0, x1 + 0.05, top + 0.05, 0.05), shade(STEEL, -0.3));
  const magenta = new Color(BUNKER_NEON.magenta);
  const cyan = new Color(BUNKER_NEON.cyan);
  bin.add('glow', faceQuad(face, x0, bottom, x1, top, 0.004), (_x: number, y: number) =>
    new Color().lerpColors(magenta, cyan, clamp01((y - bottom) / (top - bottom))).multiplyScalar(0.85),
  );
  // The leaf, swung a third open into the landing.
  const hingeX = x0;
  const hingeZ = plane + 0.02;
  const open = 0.6;
  const width = x1 - x0;
  const ex = hingeX + Math.cos(open) * width;
  const ez = hingeZ + Math.sin(open) * width;
  bin.add('body', beamGeometry([hingeX, (bottom + top) / 2, hingeZ], [ex, (bottom + top) / 2, ez], 0.04, top - bottom), DOOR);
  // Its kick plate and handle, on the face the stair looks at.
  const along = (t: number, y: number, out: number): [number, number, number] => [
    hingeX + Math.cos(open) * width * t - Math.sin(open) * out,
    y,
    hingeZ + Math.sin(open) * width * t + Math.cos(open) * out,
  ];
  bin.add('body', beamGeometry(along(0.05, bottom + 0.12, 0.025), along(0.95, bottom + 0.12, 0.025), 0.01, 0.22), shade(STEEL, -0.1));
  bin.add('body', beamGeometry(along(0.86, -0.32, 0.04), along(0.86, -0.22, 0.04), 0.03, 0.03), STEEL);

  // Neon on the landing and up the steps, strongest at the door: a flat quad
  // on the landing and one laid along the flight's slope.
  const foot = plane + 0.42;
  const neon = (_x: number, _y: number, z: number): readonly [number, number, number, number] => {
    const t = clamp01((z - plane) / (STAIR_TOP_Z - plane));
    const c = new Color().lerpColors(magenta, cyan, t * 0.6);
    return [c.r, c.g, c.b, 0.55 * (1 - t) ** 1.3];
  };
  bin.addRGBA('light', flatQuad(BUNKER_DOOR.x + 0.12, plane, BUNKER_DOOR.x + 0.88, foot, -DEPTH + 0.015), neon);
  const slope = flatQuad(BUNKER_DOOR.x + 0.12, foot, BUNKER_DOOR.x + 0.88, STAIR_TOP_Z, 0);
  const pos = slope.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01((pos.getZ(i) - foot) / (STAIR_TOP_Z - foot));
    pos.setY(i, -DEPTH + 0.02 + t * (DEPTH - 0.06));
  }
  bin.addRGBA('light', slope, neon);
  // The wash rising out of the cut, and a faint pink haze on the pavement.
  const haze: Face = { normal: 'z+', plane: plane + 0.45 };
  bin.addRGBA('light', faceQuad(haze, BUNKER_DOOR.x + 0.14, -0.4, BUNKER_DOOR.x + 0.86, 1.25, 0), (_x, y) => [
    magenta.r,
    magenta.g,
    magenta.b,
    0.26 * (1 - clamp01((y + 0.4) / 1.65)) ** 1.6,
  ]);
  bin.addRGBA('light', flatQuad(BUNKER_DOOR.x - 0.2, STAIR_TOP_Z, BUNKER_DOOR.x + 1.1, BUNKER_DOOR.y + 1.6, 0.095), (_x, _y, z) => [
    magenta.r,
    magenta.g,
    magenta.b,
    0.13 * (1 - clamp01((z - STAIR_TOP_Z) / (BUNKER_DOOR.y + 1.6 - STAIR_TOP_Z))) ** 1.5,
  ]);
}

// ---------------------------------------------------------------------------
// The vending machine and the cat
// ---------------------------------------------------------------------------

const VENDING_TOP = 1.78;

/**
 * An unbranded drinks machine facing the street: white, a blue band, three
 * lit rows of bottles with their buttons under each, the pickup flap. No coin
 * slot and no prices (D-024). The hint: a small sticker, a pink down arrow on
 * a white square, low on its front by the stair.
 */
function vendingMachine(bin: GeometryBin, floor: number): void {
  const x0 = BUNKER_VENDING.x + 0.08;
  const x1 = BUNKER_VENDING.x + 0.92;
  const z0 = BUNKER_VENDING.y + 0.12;
  const z1 = BUNKER_VENDING.y + 0.86;
  const face: Face = { normal: 'z+', plane: z1 };
  // Its tile is a cracked concrete pad level with the ground, then the plinth.
  bin.add('body', flatQuad(BUNKER_VENDING.x, BUNKER_VENDING.y, BUNKER_VENDING.x + 1, BUNKER_VENDING.y + 1, 0.004), shade(CONCRETE, -0.08));
  bin.add('body', boxGeometry(x0 - 0.02, 0, z0 - 0.02, x1 + 0.02, 0.06, z1 + 0.02), CONCRETE_DARK);
  bin.add('body', boxGeometry(x0, 0.06, z0, x1, VENDING_TOP, z1), (_x: number, y: number) => shade(0xe8ebee, -0.06 * (1 - clamp01(y / 1.4))));
  bin.add('body', boxGeometry(x0 - 0.01, 1.58, z0 - 0.01, x1 + 0.01, VENDING_TOP - 0.04, z1 + 0.01), 0x2f6fc0);
  // The lit window and its rows of bottles.
  bin.add('glow', faceQuad(face, x0 + 0.07, 0.86, x1 - 0.07, 1.52, 0.004), 0xdcefff);
  const rows = [1.34, 1.11, 0.9];
  const bottles = [0xe2483a, 0x2f9e5b, 0xf0b429, 0x2f6fc0, 0x7a4fc0, 0xffffff];
  rows.forEach((v, row) => {
    for (let k = 0; k < 6; k++) {
      const u = x0 + 0.12 + k * 0.118;
      const colour = bottles[(k + row * 2) % bottles.length]!;
      bin.add('glow', faceBox(face, u, v, 0.005, u + 0.07, v + 0.15, 0.03), shade(colour, -0.05));
      bin.add('glow', faceBox(face, u + 0.02, v - 0.035, 0.005, u + 0.05, v - 0.015, 0.02), row === 1 && k === 3 ? 0xff5050 : 0x66d9ff);
    }
  });
  bin.add('body', faceBox(face, x0 + 0.05, 0.84, 0, x1 - 0.05, 0.86, 0.02), 0xb9c0c7);
  // The pickup flap and the kick panel.
  bin.add('body', faceBox(face, x0 + 0.12, 0.16, 0, x1 - 0.12, 0.38, 0.015), 0x1f2328);
  bin.add('body', faceBox(face, x0 + 0.04, 0.44, 0, x1 - 0.04, 0.78, 0.01), 0xd5dadf);
  // The sticker, low by the stair: a white square, a pink arrow pointing down.
  const su = x0 + 0.06;
  bin.add('body', faceBox(face, su, 0.5, 0.01, su + 0.12, 0.62, 0.014), 0xfafafa);
  bin.add('glow', faceBox(face, su + 0.05, 0.56, 0.014, su + 0.07, 0.6, 0.017), BUNKER_NEON.magenta);
  const arrow = flatPolygon([[su + 0.025, 0], [su + 0.095, 0], [su + 0.06, 0.05]], 0).rotateX(Math.PI / 2);
  bin.add('glow', arrow.translate(0, 0.565, z1 + 0.017), BUNKER_NEON.magenta);
  // Its light on the pavement in front.
  const cool = new Color(0xdcefff);
  bin.addRGBA('light', flatQuad(x0 - 0.1, z1, x1 + 0.1, z1 + 0.9, floor + 0.012), (_x, _y, z) => [
    cool.r,
    cool.g,
    cool.b,
    0.16 * (1 - clamp01((z - z1) / 0.9)),
  ]);
}

/** A calico cat curled on the machine, head up, tail hanging over the edge. */
function sleepingCat(bin: GeometryBin, x: number, y: number, z: number): void {
  const white = 0xf3efe6;
  const ginger = 0xd8843a;
  const black = 0x2b2622;
  bin.add('body', boxGeometry(x - 0.2, y, z - 0.12, x + 0.16, y + 0.15, z + 0.12), white);
  bin.add('body', boxGeometry(x - 0.2, y + 0.15, z - 0.1, x - 0.02, y + 0.17, z + 0.06), ginger);
  bin.add('body', boxGeometry(x + 0.02, y + 0.12, z - 0.12, x + 0.15, y + 0.155, z + 0.0), black);
  // The head, turned to the street, with its ears.
  const hx = x + 0.18;
  const hz = z + 0.06;
  bin.add('body', boxGeometry(hx - 0.09, y + 0.08, hz - 0.08, hx + 0.08, y + 0.23, hz + 0.08), white);
  bin.add('body', boxGeometry(hx - 0.09, y + 0.17, hz - 0.08, hx - 0.0, y + 0.235, hz + 0.02), ginger);
  for (const dx of [-0.055, 0.045]) {
    bin.add('body', coneGeometry(hx + dx, y + 0.23, hz - 0.01, 0.035, 0.07, 4), dx < 0 ? ginger : white);
  }
  bin.add('body', boxGeometry(hx - 0.05, y + 0.15, hz + 0.08, hx - 0.02, y + 0.16, hz + 0.084), black);
  bin.add('body', boxGeometry(hx + 0.02, y + 0.15, hz + 0.08, hx + 0.05, y + 0.16, hz + 0.084), black);
  bin.add('body', boxGeometry(hx - 0.01, y + 0.12, hz + 0.08, hx + 0.01, y + 0.135, hz + 0.086), 0xe58a96);
  // The tail, down over the machine's west edge, towards the stair.
  const seed = hash01(x * 10, z * 10, 707);
  bin.add('body', beamGeometry([x - 0.2, y + 0.06, z + 0.02], [x - 0.36, y + 0.02, z + 0.06], 0.045), ginger);
  bin.add('body', beamGeometry([x - 0.36, y + 0.02, z + 0.06], [x - 0.39, y - 0.24 - seed * 0.04, z + 0.1], 0.04), ginger);
}
