import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import {
  ARENA_BOX,
  ARENA_DUMMY_TILE,
  ARENA_HEIGHT,
  ARENA_RING_FENCE,
  ARENA_RING_GATE,
  ARENA_TUNNEL,
  ARENA_WIDTH,
  arenaTierAt,
  arenaTileAt,
  type ArenaTileKind,
} from '@strkworld/shared';
import type { FixedRoomLevelMap, FixedRoomStationPresentation } from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { PIXELS_PER_UNIT } from './coords.js';
import type { FloatingStyleOptions, SignStyleOptions } from './labels.js';
import {
  GeometryBin,
  ResourceBag,
  beamGeometry,
  boxGeometry,
  clamp01,
  coneGeometry,
  createOpacityFader,
  cylinderGeometry,
  faceBox,
  faceDisc,
  faceQuad,
  flatQuad,
  flushBin,
  hash01,
  mixHex,
  prismZ,
  shade,
  sphereGeometry,
  standardMaterial,
  unlitMaterial,
  type Face,
  type Point2,
} from './palette.js';
import type { LabelFactory, Occluder, RoomView, TextLabel } from './types.js';

/**
 * The gladiator pit's arena in 3D (D-114): an open-air stadium oval at the
 * interiors' origin. Raked sand, a podium wall with two stairs, five stone
 * tiers with a wooden bench on every seat tile, an arcade behind them with
 * banners, braziers on the podium, the south tunnel, the emperor's box (the
 * reserved station) and, in the middle, the fenced ring with its gate, the
 * gate lamp, its sign and the training dummy.
 *
 * The generic room shell (four walls round a flat floor) is wrong for a
 * 41 x 33 oval, so `buildFixedRoom` hands the arena to this builder. Every
 * volume is built from the shared classifier (`arenaTileAt`), standing on
 * the tile it belongs to: the tiers and stairs are walkable surfaces at a
 * height (`arenaSurfaceHeightAt`, which the presenter stands feet on), so
 * over a walkable tile nothing rises more than a low bench above that
 * tile's own surface. The south half of the stands is its own material and
 * fades as an occluder, so the near stands never hide the player.
 *
 * Draw calls: sand, north stone, south stone, seats (one InstancedMesh, one
 * instance per tier tile), banners, flames (one InstancedMesh), fence, gate
 * (two leaves, one InstancedMesh), gate lamp, dummy, and two labels: 12.
 * The combat feedback (C's `arena-fx.ts`) mounts under `fxMount`.
 */

/** Walking-surface heights by kind (world units; one tile is one unit). */
export const ARENA_SURFACE = Object.freeze({
  sand: 0,
  stair: 0.4,
  /** Tier k stands at `tier1 + tierStep * (k - 1)`: 0.8 / 1.25 / 1.7 / 2.15 / 2.6. */
  tier1: 0.8,
  tierStep: 0.45,
  podium: 1.0,
  arcade: 3.6,
});

export const ARENA_RING_SIGN_TEXT = 'THE RING';
/** The gate lamp: green while the ring is free, red while a fight holds it. */
export const ARENA_GATE_LAMP = Object.freeze({ open: 0x5cff7a, busy: 0xff4a3a });

/**
 * Height of the top of an arena-local tile: the walking surface of sand,
 * stairs, tiers and the tunnel, and the top of the solid podium and arcade.
 * The ring, its fence and gate, the dummy and the void are at sand level.
 */
export function arenaSurfaceHeightAt(tileX: number, tileY: number): number {
  const kind = arenaTileAt(tileX, tileY);
  switch (kind) {
    case 'stair':
      return ARENA_SURFACE.stair;
    case 'tier':
      return ARENA_SURFACE.tier1 + ARENA_SURFACE.tierStep * (arenaTierAt(tileX, tileY) - 1);
    case 'podium':
    case 'box':
      return ARENA_SURFACE.podium;
    case 'arcade':
      return ARENA_SURFACE.arcade;
    default:
      return 0;
  }
}

/** The arena's room view: the generic contract plus the ring's gate and the fx mount. */
export interface ArenaRoomView extends RoomView {
  /** Open the gate and light the lamp green, or close it and light it red. */
  setGate(state: 'open' | 'busy'): void;
  /** Where the combat feedback mounts (arena-local, like the room's group). */
  readonly fxMount: Group;
  /** The training dummy: a group at the dummy tile's centre, its pivot at the post's foot. */
  readonly dummy: Object3D;
  /** The ring gate's leaves (`arena:gate`), for the press-E cues' glow on the gate station. */
  readonly gate: Object3D;
}

const TRAVERTINE = 0xd8c6a2;
const TRAVERTINE_DARK = 0xb9a582;
const PODIUM = 0xb39c78;
const ARCADE = 0xcdb68e;
const ARCADE_SHADOW = 0x4a3a2c;
const SAND = 0xdcc191;
const SAND_DARK = 0xc2a473;
const EARTH = 0x5b4a3a;
const TUNNEL = 0x8e7b62;
const TIMBER = 0x7a5532;
const ROPE = 0xcdb688;
const WOOD = 0x9c6b3e;
const IRON = 0x3a3532;
const PURPLE = 0x5a2a6e;
/** Brand ember palette (docs/brand/README.md). */
const EMBER = 0xf56a16;
const GOLD = 0xffc12e;
const BANNER_RED = 0xa8261d;
const NAVY = 0x23325c;
const BONE = 0xe9dfc9;

const TORCH_COUNT = 16;
const GATE_HINGE_INSET = 0.1;
const GATE_HEIGHT = 1.05;
const GATE_POST_TOP = 2.0;

/** The ring's sign over the gate, ember on outline brown. */
export const ARENA_RING_SIGN: SignStyleOptions = Object.freeze({
  width: 1.8,
  height: 0.32,
  background: '#24120A',
  foreground: '#FFF6E6',
  accent: '#F56A16',
  gradient: Object.freeze(['#FFD23A', '#E8501A']),
  cornerRadius: 0.08,
  borderWidth: 0.06,
  hairline: false,
  titleFont: 'display',
  titleWeight: 900,
  titleTracking: 0.14,
  uppercase: true,
} satisfies SignStyleOptions);

const BOX_LABEL: FloatingStyleOptions = Object.freeze({
  lineHeight: 0.24,
  foreground: '#FFF6E6',
  background: 'rgba(36,18,10,0.88)',
  border: '#F56A16',
  font: 'sans',
  cornerRadius: 0.35,
});

type Animator = (elapsedMs: number) => void;

export function buildArenaRoom(
  map: FixedRoomLevelMap,
  labels: LabelFactory,
  origin: { readonly x: number; readonly y: number } = ROOM_ORIGIN,
  options: { readonly reducedMotion?: () => boolean } = {},
): ArenaRoomView {
  const res = new ResourceBag();
  const group = new Group();
  group.name = `room:${map.building}`;
  group.userData['building'] = map.building;
  group.userData['level'] = map.level;
  group.position.set(origin.x / PIXELS_PER_UNIT, 0, origin.y / PIXELS_PER_UNIT);
  const reduced = (): boolean => {
    try {
      return options.reducedMotion?.() === true;
    } catch {
      return false;
    }
  };

  const textLabels: TextLabel[] = [];
  const animators: Animator[] = [];
  const occluders: Occluder[] = [];
  let boxLabel: TextLabel | null = null;
  let boxText = '';
  let setGateTarget: (open: number) => void = () => {};
  let lampMaterial: MeshBasicMaterial | null = null;
  let gateMesh: Object3D | null = null;
  const fxMount = new Group();
  fxMount.name = 'arena:fx-mount';
  const dummy = new Group();
  dummy.name = 'arena:dummy';

  const bin = new GeometryBin();
  try {
    sandFloor(bin);
    stands(bin);
    tunnel(bin);
    emperorsBox(bin);
    fence(bin);
    const torches = torchTiles();
    for (const tile of torches) brazierStand(bin, tile.x + 0.5, tile.y + 0.5);
    banners(bin);

    flushBin(bin, 'sand', res.material(standardMaterial({ roughness: 0.96 })), res, group, { name: 'arena:sand', receive: true });
    flushBin(bin, 'stone', res.material(standardMaterial({ roughness: 0.88 })), res, group, {
      name: 'arena:stone',
      cast: true,
      receive: true,
    });
    const southMaterial = res.material(standardMaterial({ roughness: 0.88 }));
    const south = flushBin(bin, 'south', southMaterial, res, group, { name: 'arena:stone-south', cast: true, receive: true });
    if (south) {
      // Everything south of the ring's gate row: the near stands, the tunnel
      // walls and the south arcade, which would otherwise hide the player.
      occluders.push(Object.freeze({
        bounds: Object.freeze({
          minX: group.position.x,
          maxX: group.position.x + ARENA_WIDTH,
          minZ: group.position.z + ARENA_RING_GATE.y + 1,
          maxZ: group.position.z + ARENA_HEIGHT,
          height: ARENA_SURFACE.arcade + 0.6,
        }),
        setOpacity: createOpacityFader([southMaterial]),
      }));
    }
    flushBin(bin, 'banner', res.material(standardMaterial({ roughness: 0.8 })), res, group, { name: 'arena:banners' });
    flushBin(bin, 'fence', res.material(standardMaterial({ roughness: 0.85 })), res, group, {
      name: 'arena:fence',
      cast: true,
      receive: true,
    });

    group.add(seats(res));
    group.add(flames(res, torches, animators, reduced));
    const gate = gateLeaves(res);
    group.add(gate.mesh);
    gateMesh = gate.mesh;
    setGateTarget = gate.setTarget;
    animators.push((elapsed) => gate.update(elapsed, reduced()));

    // The lamp over the gate: one additive bulb, its colour the ring's state.
    lampMaterial = res.material(unlitMaterial({ additive: true, vertexColors: false, color: ARENA_GATE_LAMP.open }));
    const lampBin = new GeometryBin();
    try {
      const gx = ARENA_RING_GATE.x + ARENA_RING_GATE.width / 2;
      const gz = ARENA_RING_GATE.y + 0.5;
      lampBin.add('lamp', sphereGeometry(gx, GATE_POST_TOP + 0.36, gz, 0.09, { widthSegments: 10, heightSegments: 6 }), 0xb0b0b0);
      lampBin.add('lamp', sphereGeometry(gx, GATE_POST_TOP + 0.36, gz, 0.15, { widthSegments: 10, heightSegments: 6 }), 0x303030);
      flushBin(lampBin, 'lamp', lampMaterial, res, group, { name: 'arena:gate-lamp', renderOrder: 2 });
    } finally {
      lampBin.dispose();
    }

    // The training dummy, its own group so the combat fx can flash, wobble
    // and topple it about the post's foot.
    dummy.position.set(ARENA_DUMMY_TILE.x + 0.5, 0, ARENA_DUMMY_TILE.y + 0.5);
    const dummyBin = new GeometryBin();
    try {
      trainingDummy(dummyBin);
      flushBin(dummyBin, 'dummy', res.material(standardMaterial({ roughness: 0.9 })), res, dummy, {
        name: 'arena:dummy-body',
        cast: true,
        receive: true,
      });
    } finally {
      dummyBin.dispose();
    }
    group.add(dummy);
    group.add(fxMount);

    // The ring's sign on the gate's crossbar, facing the camera (south).
    const sign = labels.sign(ARENA_RING_SIGN_TEXT, ARENA_RING_SIGN);
    textLabels.push(sign);
    sign.object.position.set(ARENA_RING_GATE.x + ARENA_RING_GATE.width / 2, GATE_POST_TOP - 0.2, ARENA_RING_GATE.y + 0.62);
    sign.object.userData['area'] = 'arena-ring';
    group.add(sign.object);

    // The emperor's box: the reserved station's label over its canopy.
    const station = map.stations[0];
    if (station) {
      boxText = station.label;
      boxLabel = labels.floating(station.label, BOX_LABEL);
      textLabels.push(boxLabel);
      boxLabel.object.position.set(station.x + station.width / 2, ARENA_SURFACE.podium + 2.05, station.y + 0.5);
      boxLabel.object.userData['station'] = station.station;
      group.add(boxLabel.object);
    }
  } catch (error) {
    bin.dispose();
    for (const label of textLabels) {
      try {
        label.dispose();
      } catch {
        // The construction error stays authoritative.
      }
    }
    res.dispose();
    throw error;
  }
  bin.dispose();

  let gateState: 'open' | 'busy' = 'open';
  let elapsed = 0;
  let disposed = false;
  return {
    building: map.building,
    group,
    occluders,
    fxMount,
    dummy,
    gate: gateMesh!,
    setGate(state) {
      if (disposed || (state !== 'open' && state !== 'busy')) return;
      gateState = state;
      setGateTarget(state === 'open' ? 1 : 0);
      lampMaterial?.color.setHex(state === 'open' ? ARENA_GATE_LAMP.open : ARENA_GATE_LAMP.busy);
      group.userData['gate'] = gateState;
    },
    setStations(presentations: readonly FixedRoomStationPresentation[]) {
      if (disposed || !Array.isArray(presentations) || !boxLabel) return;
      for (const presentation of presentations) {
        if (presentation?.station !== map.stations[0]?.station) continue;
        const text = typeof presentation.label === 'string' && presentation.label.trim().length > 0 ? presentation.label : boxText;
        if (text !== boxText) {
          boxText = text;
          boxLabel.setText(text);
        }
        boxLabel.object.userData['highlighted'] = presentation.highlighted === true;
      }
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      for (const animate of animators) animate(elapsed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const label of textLabels) {
        try {
          label.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      textLabels.length = 0;
      group.removeFromParent();
      group.clear();
      res.dispose();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Arena disposal failed');
    },
  };
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const OVAL_CX = 20.5;
const OVAL_CY = 16.5;
const OVAL_HALF = 5;

/** Distance (tiles) from a point to the oval's axis segment, and the outward direction. */
function ovalOutward(x: number, z: number): { readonly d: number; readonly ox: number; readonly oz: number } {
  const sx = Math.max(OVAL_CX - OVAL_HALF, Math.min(OVAL_CX + OVAL_HALF, x));
  const dx = x - sx;
  const dz = z - OVAL_CY;
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? { d, ox: dx / d, oz: dz / d } : { d, ox: 0, oz: 1 };
}

/** The bin a stone volume on row `y` goes to: south of the gate row fades. */
function stoneKey(y: number): 'stone' | 'south' {
  return y > ARENA_RING_GATE.y ? 'south' : 'stone';
}

function forEachTile(visit: (x: number, y: number, kind: ArenaTileKind) => void): void {
  for (let y = 0; y < ARENA_HEIGHT; y++) {
    for (let x = 0; x < ARENA_WIDTH; x++) visit(x, y, arenaTileAt(x, y));
  }
}

const NEIGHBOURS: readonly (readonly [number, number, Face['normal']])[] = [
  [0, -1, 'z-'],
  [0, 1, 'z+'],
  [-1, 0, 'x-'],
  [1, 0, 'x+'],
];

/** The face of tile (x, y) looking towards its neighbour (dx, dy). */
function sideFace(x: number, y: number, dx: number, dy: number): { face: Face; u0: number; u1: number } {
  if (dy === -1) return { face: { normal: 'z-', plane: y }, u0: x, u1: x + 1 };
  if (dy === 1) return { face: { normal: 'z+', plane: y + 1 }, u0: x, u1: x + 1 };
  if (dx === -1) return { face: { normal: 'x-', plane: x }, u0: y, u1: y + 1 };
  return { face: { normal: 'x+', plane: x + 1 }, u0: y, u1: y + 1 };
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/** A flat strip from x0 to x1 on row z, `per` segments a tile, facing up at height y. */
function strip(x0: number, x1: number, z: number, y: number, per: number): BufferGeometry {
  return new PlaneGeometry(x1 - x0, 1, Math.max(1, Math.round((x1 - x0) * per)), per)
    .rotateX(-Math.PI / 2)
    .translate((x0 + x1) / 2, y, z + 0.5);
}

/** Row runs of tiles a test accepts, as [x0, x1) pairs. */
function rowRuns(y: number, test: (kind: ArenaTileKind) => boolean): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x <= ARENA_WIDTH; x++) {
    const hit = x < ARENA_WIDTH && test(arenaTileAt(x, y));
    if (hit && start < 0) start = x;
    if (!hit && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  return runs;
}

const SAND_KINDS: ReadonlySet<ArenaTileKind> = new Set<ArenaTileKind>(['sand', 'ring', 'fence', 'gate', 'dummy']);

/**
 * The floor in row strips (a few dozen bin parts, not thousands): earth under
 * the void, packed earth in the tunnel, and the sand raked in rings round the
 * oval, brighter inside the ring and darker in a band round its fence. The
 * paint is per vertex, so the rings shade softly across each strip.
 */
function sandFloor(bin: GeometryBin): void {
  const fence = ARENA_RING_FENCE;
  const sand = (x: number, _y: number, z: number): Color => {
    const { d } = ovalOutward(x, z);
    const raked = Math.sin(d * Math.PI * 1.9) > 0.6 ? -0.04 : 0.008;
    const inRing = x > fence.x + 1 && x < fence.x + fence.width - 1 && z > fence.y + 1 && z < fence.y + fence.height - 1;
    const band = x > fence.x - 1 && x < fence.x + fence.width + 1 && z > fence.y - 1 && z < fence.y + fence.height + 1;
    const base = inRing ? mixHex(SAND, 0xe8d1a2, 0.4) : band ? SAND_DARK : SAND;
    return shade(base, raked + (hash01(Math.round(x * 4), Math.round(z * 4), 9) - 0.5) * 0.025);
  };
  for (let y = 0; y < ARENA_HEIGHT; y++) {
    for (const [x0, x1] of rowRuns(y, (kind) => kind === 'void')) {
      bin.add('sand', strip(x0, x1, y, 0, 1), (x: number, _y: number, z: number) => shade(EARTH, (hash01(Math.round(x), Math.round(z), 5) - 0.5) * 0.06));
    }
    for (const [x0, x1] of rowRuns(y, (kind) => kind === 'tunnel')) {
      bin.add('sand', strip(x0, x1, y, 0, 1), (x: number, _y: number, z: number) => shade(TUNNEL, (hash01(Math.round(x), Math.round(z), 7) - 0.5) * 0.05));
      // A worn track down the tunnel's middle.
      if (x0 <= ARENA_TUNNEL.x + 1 && x1 > ARENA_TUNNEL.x + 1) {
        bin.add('sand', flatQuad(ARENA_TUNNEL.x + 1.2, y, ARENA_TUNNEL.x + 1.8, y + 1, 0.004), shade(SAND_DARK, -0.05));
      }
    }
    for (const [x0, x1] of rowRuns(y, (kind) => SAND_KINDS.has(kind))) bin.add('sand', strip(x0, x1, y, 0, 2), sand);
  }
}

// ---------------------------------------------------------------------------
// The stands: podium, stairs, tiers, arcade
// ---------------------------------------------------------------------------

function stands(bin: GeometryBin): void {
  forEachTile((x, y, kind) => {
    const key = stoneKey(y);
    const top = arenaSurfaceHeightAt(x, y);
    switch (kind) {
      case 'tier': {
        const tier = arenaTierAt(x, y);
        const base = tier % 2 === 0 ? TRAVERTINE : mixHex(TRAVERTINE, TRAVERTINE_DARK, 0.18);
        bin.add(key, boxGeometry(x, 0, y, x + 1, top, y + 1), (_px: number, py: number) =>
          shade(base, -0.12 + 0.12 * clamp01(py / top) + (hash01(x, y, 11) - 0.5) * 0.03),
        );
        // A lighter nosing on every edge that drops to a lower tier or the podium.
        for (const [dx, dy] of NEIGHBOURS) {
          const below = arenaSurfaceHeightAt(x + dx, y + dy);
          const nk = arenaTileAt(x + dx, y + dy);
          if (below >= top || nk === 'void' || nk === 'arcade') continue;
          const { face, u0, u1 } = sideFace(x, y, dx, dy);
          bin.add(key, faceBox(face, u0, top - 0.05, -0.04, u1, top, 0.01), shade(TRAVERTINE, 0.08));
        }
        break;
      }
      case 'stair': {
        // Two treads up from the sand to tier 1, the stair's walking surface between.
        bin.add(key, boxGeometry(x, 0, y, x + 1, top, y + 1), shade(PODIUM, 0.02));
        const inward = x < OVAL_CX ? 1 : -1;
        const x0 = inward > 0 ? x + 0.55 : x;
        const x1 = inward > 0 ? x + 1 : x + 0.45;
        bin.add(key, boxGeometry(x0, top - 0.2, y + 0.04, x1, top - 0.19, y + 0.96), shade(PODIUM, 0.08));
        break;
      }
      case 'podium':
      case 'box': {
        bin.add(key, boxGeometry(x, 0, y, x + 1, top - 0.08, y + 1), shade(PODIUM, (hash01(x, y, 13) - 0.5) * 0.05));
        bin.add(key, boxGeometry(x - 0.01, top - 0.08, y - 0.01, x + 1.01, top, y + 1.01), shade(PODIUM, -0.16));
        // The podium's face to the sand: dressed panels and an ember band.
        for (const [dx, dy] of NEIGHBOURS) {
          if (arenaTileAt(x + dx, y + dy) !== 'sand') continue;
          const { face, u0, u1 } = sideFace(x, y, dx, dy);
          bin.add(key, faceQuad(face, u0 + 0.06, 0.14, u1 - 0.06, 0.66, 0.004), shade(PODIUM, -0.08));
          bin.add(key, faceQuad(face, u0, 0.72, u1, 0.8, 0.005), shade(EMBER, -0.25));
        }
        break;
      }
      case 'arcade': {
        bin.add(key, boxGeometry(x, 0, y, x + 1, top, y + 1), (_px: number, py: number) =>
          shade(ARCADE, -0.08 + 0.06 * clamp01(py / top) + (hash01(x, y, 17) - 0.5) * 0.03),
        );
        bin.add(key, boxGeometry(x - 0.02, top, y - 0.02, x + 1.02, top + 0.12, y + 1.02), shade(ARCADE, -0.14));
        // Arches every other tile of arc: one storey over the tiers, two to the outside.
        const arch = (x + y) % 2 === 0;
        for (const [dx, dy] of NEIGHBOURS) {
          const nk = arenaTileAt(x + dx, y + dy);
          const { face, u0, u1 } = sideFace(x, y, dx, dy);
          const uc = (u0 + u1) / 2;
          if (nk === 'tier' && arch) {
            const floor = arenaSurfaceHeightAt(x + dx, y + dy);
            const head = Math.min(top - 0.22, floor + 0.62);
            bin.add(key, faceQuad(face, uc - 0.26, floor + 0.04, uc + 0.26, head, 0.004), ARCADE_SHADOW);
            bin.add(key, faceDisc(face, uc, head, 0.001, 0.26, 0.004, 10), ARCADE_SHADOW);
          } else if (nk === 'void' && arch) {
            for (const [v0, v1] of [[0.25, 1.35], [1.95, 2.95]] as const) {
              bin.add(key, faceQuad(face, uc - 0.28, v0, uc + 0.28, v1, 0.004), ARCADE_SHADOW);
              bin.add(key, faceDisc(face, uc, v1, 0.001, 0.28, 0.004, 10), ARCADE_SHADOW);
            }
            bin.add(key, faceBox(face, u0, 1.62, 0, u1, 1.72, 0.06), shade(ARCADE, -0.12));
          }
        }
        break;
      }
      default:
        break;
    }
  });
}

/** The tunnel's walls (as high as the stands either side) and an arch over its mouth. */
function tunnel(bin: GeometryBin): void {
  forEachTile((x, y, kind) => {
    if (kind !== 'tunnel-wall') return;
    let neighbour = 1.2;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const nk = arenaTileAt(x + dx, y + dy);
      if (nk === 'tier' || nk === 'podium' || nk === 'stair') neighbour = Math.max(neighbour, arenaSurfaceHeightAt(x + dx, y + dy));
      if (nk === 'arcade') neighbour = Math.max(neighbour, ARENA_SURFACE.tierStep * 4 + ARENA_SURFACE.tier1);
    }
    const top = neighbour + 0.28;
    bin.add('south', boxGeometry(x, 0, y, x + 1, top, y + 1), (_px: number, py: number) => shade(PODIUM, -0.1 + 0.08 * clamp01(py / top)));
    bin.add('south', boxGeometry(x - 0.02, top, y - 0.02, x + 1.02, top + 0.08, y + 1.02), shade(PODIUM, -0.18));
  });
  // The mouth: an arch over the tunnel where it meets the sand, clear of heads.
  const x0 = ARENA_TUNNEL.x;
  const x1 = ARENA_TUNNEL.x + ARENA_TUNNEL.width;
  const z0 = ARENA_TUNNEL.y + 1.02;
  const z1 = ARENA_TUNNEL.y + 1.5;
  const spring = 2.15;
  const rise = 0.45;
  const half = (x1 - x0) / 2;
  const radius = (half * half + rise * rise) / (2 * rise);
  const cx = (x0 + x1) / 2;
  const cy = spring + rise - radius;
  const limit = Math.asin(half / radius);
  const count = 7;
  for (let i = 0; i < count; i++) {
    const a0 = -limit + (2 * limit * i) / count;
    const a1 = -limit + (2 * limit * (i + 1)) / count;
    const p0: Point2 = [cx + radius * Math.sin(a0), cy + radius * Math.cos(a0)];
    const p1: Point2 = [cx + radius * Math.sin(a1), cy + radius * Math.cos(a1)];
    const top = spring + rise + 0.38;
    bin.add('south', prismZ([p0, p1, [p1[0], top], [p0[0], top]], z0, z1), shade(ARCADE, i === 3 ? 0.06 : i % 2 === 0 ? 0 : -0.05));
  }
}

/** The emperor's box: a canopy on four posts over the reserved station, draped in purple. */
function emperorsBox(bin: GeometryBin): void {
  const x = ARENA_BOX.x;
  const z = ARENA_BOX.y;
  const floor = ARENA_SURFACE.podium;
  const key = stoneKey(z);
  for (const [px, pz] of [[x + 0.08, z + 0.08], [x + 0.92, z + 0.08], [x + 0.08, z + 0.92], [x + 0.92, z + 0.92]] as const) {
    bin.add(key, cylinderGeometry(px, floor, pz, 0.05, 0.06, 1.55, 6), shade(BONE, -0.05));
  }
  // The canopy stays inside the box's own tile, clear of heads on the tiers behind.
  bin.add(key, boxGeometry(x, floor + 1.55, z, x + 1, floor + 1.68, z + 1), GOLD);
  bin.add(key, prismZ([[x, floor + 1.68], [x + 1, floor + 1.68], [x + 0.5, floor + 1.98]], z, z + 1), PURPLE);
  // The drape on the parapet facing the sand, and the closed chair behind it.
  const face: Face = { normal: 'z+', plane: z + 1 };
  bin.add(key, faceBox(face, x + 0.05, floor - 0.62, 0, x + 0.95, floor + 0.32, 0.03), shade(PURPLE, 0.05));
  bin.add(key, faceBox(face, x + 0.05, floor - 0.62, 0.03, x + 0.95, floor - 0.54, 0.035), GOLD);
  bin.add(key, boxGeometry(x + 0.3, floor, z + 0.25, x + 0.7, floor + 0.85, z + 0.55), shade(PURPLE, -0.1));
}

// ---------------------------------------------------------------------------
// Seats, torches, banners
// ---------------------------------------------------------------------------

/** One wooden bench per tier tile, along the back of the step: one draw call. */
function seats(res: ResourceBag): InstancedMesh {
  const tiles: { x: number; y: number }[] = [];
  forEachTile((x, y, kind) => {
    if (kind === 'tier') tiles.push({ x, y });
  });
  const bin = new GeometryBin();
  let geometry: BufferGeometry | null;
  try {
    // Local +Z is outward (the back of the step); the plank and two risers.
    bin.add('seat', boxGeometry(-0.44, 0.02, 0.08, 0.44, 0.1, 0.4), 0xffffff);
    bin.add('seat', boxGeometry(-0.36, 0, 0.12, -0.28, 0.02, 0.36), 0xbbbbbb);
    bin.add('seat', boxGeometry(0.28, 0, 0.12, 0.36, 0.02, 0.36), 0xbbbbbb);
    geometry = bin.take('seat');
  } finally {
    bin.dispose();
  }
  const material = res.material(standardMaterial({ roughness: 0.8 }));
  const mesh = new InstancedMesh(res.geometry(geometry!), material, tiles.length);
  mesh.name = 'arena:seats';
  mesh.receiveShadow = true;
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const scale = new Vector3(1, 1, 1);
  const position = new Vector3();
  const colour = new Color();
  tiles.forEach(({ x, y }, index) => {
    // Square to the grid, so the benches run in rows along each step's edge.
    const { ox, oz } = ovalOutward(x + 0.5, y + 0.5);
    rotation.setFromAxisAngle(up, Math.round(Math.atan2(ox, oz) / (Math.PI / 2)) * (Math.PI / 2));
    position.set(x + 0.5, arenaSurfaceHeightAt(x, y), y + 0.5);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, colour.set(WOOD).offsetHSL(0, 0, (hash01(x, y, 19) - 0.5) * 0.06));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  res.disposable(mesh);
  return mesh;
}

/** Sixteen podium tiles, evenly round the oval, clear of the stairs and the box. */
export function torchTiles(): { readonly x: number; readonly y: number }[] {
  const podium: { x: number; y: number; angle: number }[] = [];
  forEachTile((x, y, kind) => {
    if (kind !== 'podium') return;
    if (Math.abs(x - ARENA_BOX.x) <= 1 && Math.abs(y - ARENA_BOX.y) <= 1) return;
    if (arenaTileAt(x, y - 1) === 'stair' || arenaTileAt(x, y + 1) === 'stair') return;
    podium.push({ x, y, angle: Math.atan2(y + 0.5 - OVAL_CY, x + 0.5 - OVAL_CX) });
  });
  podium.sort((a, b) => a.angle - b.angle);
  const picked: { x: number; y: number }[] = [];
  for (let i = 0; i < TORCH_COUNT; i++) {
    const tile = podium[Math.floor(((i + 0.5) * podium.length) / TORCH_COUNT)]!;
    picked.push(Object.freeze({ x: tile.x, y: tile.y }));
  }
  return picked;
}

function brazierStand(bin: GeometryBin, x: number, z: number): void {
  const base = ARENA_SURFACE.podium;
  const key = stoneKey(Math.floor(z));
  bin.add(key, cylinderGeometry(x, base, z, 0.04, 0.06, 0.34, 6), IRON);
  bin.add(key, cylinderGeometry(x, base + 0.3, z, 0.18, 0.1, 0.14, 8), IRON);
}

/** The braziers' flames: one InstancedMesh of 16, flickering, slower for reduced motion. */
function flames(
  res: ResourceBag,
  torches: readonly { readonly x: number; readonly y: number }[],
  animators: Animator[],
  reduced: () => boolean,
): InstancedMesh {
  const bin = new GeometryBin();
  let geometry: BufferGeometry | null;
  const ember = new Color(EMBER);
  const gold = new Color(GOLD);
  try {
    const flame = (fx: number, fz: number, radius: number, height: number): void => {
      bin.add('flame', coneGeometry(fx, 0, fz, radius, height, 6), (_x: number, y: number) =>
        new Color().lerpColors(ember, gold, clamp01(y / height)).multiplyScalar(0.95),
      );
    };
    flame(0, 0, 0.14, 0.46);
    flame(-0.06, 0.04, 0.08, 0.3);
    flame(0.07, -0.03, 0.07, 0.28);
    geometry = bin.take('flame');
  } finally {
    bin.dispose();
  }
  const material = res.material(unlitMaterial({ additive: true }));
  const mesh = new InstancedMesh(res.geometry(geometry!), material, torches.length);
  mesh.name = 'arena:flames';
  mesh.renderOrder = 2;
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const position = new Vector3();
  const place = (phase: number): void => {
    torches.forEach((tile, index) => {
      const seed = hash01(tile.x, tile.y, 29) * 10;
      const s = 0.9 + 0.1 * Math.sin(phase * 8.3 + seed) + 0.05 * Math.sin(phase * 13.1 + seed * 2);
      scale.set(1, s, 1);
      position.set(tile.x + 0.5, ARENA_SURFACE.podium + 0.42, tile.y + 0.5);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    material.opacity = arenaTorchOpacity(phase);
  };
  place(0);
  mesh.computeBoundingSphere();
  let phase = 0;
  let last = 0;
  animators.push((elapsed) => {
    const dt = Math.max(0, elapsed - last);
    last = elapsed;
    phase += (dt / 1000) * (reduced() ? 0.25 : 1);
    place(phase);
  });
  res.disposable(mesh);
  return mesh;
}

/** The torches' flicker at `t` seconds: never below 0.6, never off. */
export function arenaTorchOpacity(t: number): number {
  return 0.82 + 0.11 * Math.sin(t * 7.7) + 0.07 * Math.sin(t * 12.9 + 0.7);
}

/** Banners on the arcade's inner face, every fourth arch, red/gold then navy/bone. */
function banners(bin: GeometryBin): void {
  let arch = 0;
  const placed: { x: number; y: number; angle: number }[] = [];
  forEachTile((x, y, kind) => {
    if (kind !== 'arcade' || (x + y) % 2 !== 0) return;
    if (!NEIGHBOURS.some(([dx, dy]) => arenaTileAt(x + dx, y + dy) === 'tier')) return;
    placed.push({ x, y, angle: Math.atan2(y + 0.5 - OVAL_CY, x + 0.5 - OVAL_CX) });
  });
  placed.sort((a, b) => a.angle - b.angle);
  for (const { x, y } of placed) {
    arch += 1;
    if (arch % 4 !== 0) continue;
    const red = (arch / 4) % 2 === 0;
    for (const [dx, dy] of NEIGHBOURS) {
      if (arenaTileAt(x + dx, y + dy) !== 'tier') continue;
      const { face, u0, u1 } = sideFace(x, y, dx, dy);
      const uc = (u0 + u1) / 2;
      const top = ARENA_SURFACE.arcade + 0.02;
      const bottom = arenaSurfaceHeightAt(x + dx, y + dy) + 0.4;
      const main = red ? BANNER_RED : NAVY;
      const trim = red ? GOLD : BONE;
      // Hung flat on the wall: nothing stands more than a hair into the tier in front.
      bin.add('banner', faceBox(face, uc - 0.36, top - 0.04, 0, uc + 0.36, top + 0.02, 0.03), IRON);
      bin.add('banner', faceBox(face, uc - 0.32, bottom, 0.005, uc + 0.32, top - 0.04, 0.02), (_x: number, v: number) =>
        shade(main, -0.1 + 0.1 * clamp01((v - bottom) / (top - bottom))),
      );
      bin.add('banner', faceBox(face, uc - 0.32, top - 0.2, 0.021, uc + 0.32, top - 0.14, 0.026), trim);
      bin.add('banner', faceBox(face, uc - 0.08, (top + bottom) / 2 - 0.08, 0.021, uc + 0.08, (top + bottom) / 2 + 0.08, 0.03), trim);
      for (let k = 0; k < 4; k++) {
        const u = uc - 0.32 + ((k + 0.5) * 0.64) / 4;
        bin.add('banner', faceBox(face, u - 0.025, bottom - 0.08, 0.005, u + 0.025, bottom, 0.02), trim);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// The ring: fence, gate, dummy
// ---------------------------------------------------------------------------

/** Timber posts on every fence tile, rope rails between them, and the gate's frame. */
function fence(bin: GeometryBin): void {
  const posts: [number, number][] = [];
  forEachTile((x, y, kind) => {
    if (kind === 'fence') posts.push([x + 0.5, y + 0.5]);
  });
  const has = (x: number, z: number): boolean => posts.some(([px, pz]) => px === x && pz === z);
  for (const [x, z] of posts) {
    bin.add('fence', boxGeometry(x - 0.08, 0, z - 0.08, x + 0.08, 1.12, z + 0.08), shade(TIMBER, (hash01(x, z, 37) - 0.5) * 0.08));
    bin.add('fence', boxGeometry(x - 0.1, 1.12, z - 0.1, x + 0.1, 1.17, z + 0.1), shade(TIMBER, -0.15));
    for (const [nx, nz] of [[x + 1, z], [x, z + 1]] as const) {
      if (!has(nx, nz)) continue;
      for (const y of [0.48, 0.9]) bin.add('fence', beamGeometry([x, y, z], [nx, y, nz], 0.045), ROPE);
    }
  }
  // The gate's two posts, taller, and the crossbar the sign and lamp sit on.
  const gz = ARENA_RING_GATE.y + 0.5;
  const west = ARENA_RING_GATE.x - 0.5;
  const east = ARENA_RING_GATE.x + ARENA_RING_GATE.width + 0.5;
  for (const x of [west, east]) {
    bin.add('fence', boxGeometry(x - 0.12, 0, gz - 0.12, x + 0.12, GATE_POST_TOP, gz + 0.12), shade(TIMBER, -0.05));
    bin.add('fence', coneGeometry(x, GATE_POST_TOP, gz, 0.15, 0.18, 4), shade(TIMBER, -0.2));
  }
  bin.add('fence', boxGeometry(west, GATE_POST_TOP - 0.42, gz - 0.07, east, GATE_POST_TOP - 0.3, gz + 0.07), shade(TIMBER, -0.1));
  // The lamp's iron bracket over the crossbar's middle.
  const cx = ARENA_RING_GATE.x + ARENA_RING_GATE.width / 2;
  bin.add('fence', boxGeometry(cx - 0.03, GATE_POST_TOP - 0.3, gz - 0.03, cx + 0.03, GATE_POST_TOP + 0.2, gz + 0.03), IRON);
  bin.add('fence', cylinderGeometry(cx, GATE_POST_TOP + 0.2, gz, 0.12, 0.08, 0.06, 8), IRON);
}

/** The gate's two leaves, hinged on its posts: one InstancedMesh, eased open or shut. */
function gateLeaves(res: ResourceBag): {
  readonly mesh: InstancedMesh;
  setTarget(open: number): void;
  update(elapsed: number, reduced: boolean): void;
} {
  const west = ARENA_RING_GATE.x - 0.5 + GATE_HINGE_INSET;
  const east = ARENA_RING_GATE.x + ARENA_RING_GATE.width + 0.5 - GATE_HINGE_INSET;
  const length = (east - west) / 2 - 0.02;
  const bin = new GeometryBin();
  let geometry: BufferGeometry | null;
  try {
    // Local +X along the leaf from its hinge: two rails, three stiles and a brace.
    bin.add('gate', boxGeometry(0, 0.2, -0.04, length, 0.3, 0.04), TIMBER);
    bin.add('gate', boxGeometry(0, GATE_HEIGHT - 0.1, -0.04, length, GATE_HEIGHT, 0.04), TIMBER);
    for (const u of [0.02, length / 2, length - 0.1]) bin.add('gate', boxGeometry(u, 0.15, -0.035, u + 0.08, GATE_HEIGHT + 0.03, 0.035), shade(TIMBER, -0.08));
    bin.add('gate', beamGeometry([0.1, 0.3, 0], [length - 0.1, GATE_HEIGHT - 0.1, 0], 0.06, 0.05), shade(TIMBER, 0.06));
    bin.add('gate', boxGeometry(length - 0.16, 0.6, 0.035, length - 0.06, 0.66, 0.06), IRON);
    geometry = bin.take('gate');
  } finally {
    bin.dispose();
  }
  const mesh = new InstancedMesh(res.geometry(geometry!), res.material(standardMaterial({ roughness: 0.85 })), 2);
  mesh.name = 'arena:gate';
  mesh.castShadow = true;
  const gz = ARENA_RING_GATE.y + 0.5;
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const scale = new Vector3(1, 1, 1);
  const position = new Vector3();
  let target = 1;
  let open = 1;
  let last = 0;
  const place = (): void => {
    // Open, both leaves swing in towards the ring (north); shut, they meet.
    rotation.setFromAxisAngle(up, (Math.PI / 2) * open);
    position.set(west, 0, gz);
    mesh.setMatrixAt(0, matrix.compose(position, rotation, scale));
    rotation.setFromAxisAngle(up, Math.PI - (Math.PI / 2) * open);
    position.set(east, 0, gz);
    mesh.setMatrixAt(1, matrix.compose(position, rotation, scale));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData['open'] = open;
  };
  place();
  mesh.computeBoundingSphere();
  res.disposable(mesh);
  return {
    mesh,
    setTarget(next) {
      target = next >= 0.5 ? 1 : 0;
    },
    update(elapsed, reduced) {
      const dt = Math.max(0, elapsed - last);
      last = elapsed;
      if (open === target) return;
      // A cut for reduced motion; otherwise about half a second each way.
      open = reduced ? target : open + Math.sign(target - open) * Math.min(Math.abs(target - open), dt / 520);
      place();
    },
  };
}

/** A straw training dummy on a post: a sack body, a painted target, a crossbar for arms. */
function trainingDummy(bin: GeometryBin): void {
  const straw = 0xd9b85c;
  const sack = 0xc7a77a;
  bin.add('dummy', cylinderGeometry(0, 0, 0, 0.32, 0.36, 0.08, 10), shade(TIMBER, -0.1));
  bin.add('dummy', cylinderGeometry(0, 0, 0, 0.06, 0.07, 1.75, 8), TIMBER);
  bin.add('dummy', cylinderGeometry(0, 0.72, 0, 0.24, 0.2, 0.62, 10), sack);
  bin.add('dummy', cylinderGeometry(0, 1.3, 0, 0.18, 0.24, 0.06, 10), shade(sack, -0.12));
  bin.add('dummy', sphereGeometry(0, 1.5, 0, 0.17, { widthSegments: 10, heightSegments: 6 }), sack);
  // Rope bands round the body and the neck.
  for (const y of [0.82, 1.16]) bin.add('dummy', cylinderGeometry(0, y, 0, 0.245, 0.245, 0.04, 10), ROPE);
  bin.add('dummy', cylinderGeometry(0, 1.33, 0, 0.1, 0.1, 0.05, 8), ROPE);
  // The crossbar arms, straw tufting out of each end.
  bin.add('dummy', boxGeometry(-0.62, 1.12, -0.04, 0.62, 1.2, 0.04), TIMBER);
  for (const side of [-1, 1]) {
    bin.add('dummy', coneGeometry(0, 0, 0, 0.07, 0.16, 5).rotateZ(-side * (Math.PI / 2)).translate(side * 0.6, 1.16, 0), straw);
  }
  // The painted target on the chest, facing the gate (south, +Z).
  const face: Face = { normal: 'z+', plane: 0.22 };
  bin.add('dummy', faceDisc(face, 0, 1.0, 0, 0.16, 0.012, 14), 0xf3ead6);
  bin.add('dummy', faceDisc(face, 0, 1.0, 0.012, 0.11, 0.008, 14), BANNER_RED);
  bin.add('dummy', faceDisc(face, 0, 1.0, 0.02, 0.05, 0.006, 12), 0xf3ead6);
  // Straw sticking out under the sack.
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    bin.add('dummy', coneGeometry(0, 0, 0, 0.04, 0.12, 4).rotateX(Math.PI).translate(Math.cos(a) * 0.16, 0.44, Math.sin(a) * 0.16), straw);
  }
}
