import {
  BoxGeometry,
  Box3,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  OctahedronGeometry,
  type Group,
  type Material,
  type Object3D,
} from 'three';
import {
  PLAZA_AREA,
  PLAZA_FIXTURES,
  PLAZA_MONUMENT_STATION,
  PLAZA_SHELLS_STATION,
  PLAZA_SIGN_TEXT,
  PLAZA_STATIONS,
  type PlazaFacing,
  type PlazaFixture,
} from '../map/plaza.js';
import type { DistrictMap } from '../map/street.js';
import type { StationId } from '@strkworld/shared';
import { EMPTY_PLAZA_STATS, normalizePlazaStats, type PlazaStatsPresentation } from '../plaza-stations.js';
import { createAffordanceShells, type AffordanceSet } from './affordance.js';
import {
  GeometryBin,
  PALETTE,
  PLAZA_THEME,
  ResourceBag,
  boxGeometry,
  createOpacityFader,
  cylinderGeometry,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  pick,
  shade,
  sphereGeometry,
  standardMaterial,
  unlitMaterial,
  type Paint,
} from './palette.js';
import type { LabelFactory, Occluder, OccluderBounds, PlazaView, TextLabel } from './types.js';

/**
 * The Privacy Plaza in 3D (D-076): sandstone paving level with the pavement,
 * a gateway carrying its sign, benches, lamps, trees and planters, the
 * shell-game table, and the pool-stats monument whose faces show the Shell's
 * pre-formatted figures on STRK20 plates.
 *
 * Presentation only, under the street's rule: every volume stands on a
 * `plinth` tile, so nothing here is in the player's way; over walkable tiles
 * there is only paving and what hangs above head height (the gateway's
 * lintel and sign, tree canopies). Geometry is merged per material like the
 * street's (one draw call per bin), and the monument and gateway each get
 * their own material so they fade like buildings when they hide the player.
 * The World never learns what the figures mean: they arrive as text.
 */

/** A plaza piece that fades when it hides the player: the monument or the gateway. */
export interface PlazaOccluder extends Occluder {
  readonly kind: 'plaza';
  readonly part: 'monument' | 'gateway';
  readonly object: Object3D;
}

/** Where the plaza hangs its parts: the street's own groups, lists and resources. */
export interface PlazaParts {
  /** `street:ground`: the paving and every volume. */
  readonly ground: Group;
  /** `street:labels`: the gateway sign, the monument's faces and the table card. */
  readonly labels: Group;
  /** The street disposes these with its own signs. */
  readonly textLabels: TextLabel[];
  readonly animators: Array<(elapsedMs: number) => void>;
  readonly occluders: PlazaOccluder[];
  /** Height of the walking surface: the paving is level with the pavement. */
  readonly floorHeight: number;
}

/**
 * What each face says under its figure. A plate fits its text to its widest
 * line, so the shaft's narrow faces break their captions in two and keep
 * each line short; the wide held face takes its caption on one line.
 */
export const PLAZA_FACE_CAPTIONS = Object.freeze({
  accounts: 'ACCOUNTS\nREGISTERED',
  total: 'TOTAL\nIN POOL',
  held: 'TOP HOLDINGS',
});

/** Shown in place of a figure the Shell has not (yet) supplied. */
export const PLAZA_UNKNOWN_FIGURE = '…';

/** How long the held face shows one holding before the next, in ms. */
export const PLAZA_HELD_CYCLE_MS = 3_500;

/**
 * The monument's shaft, in world units: wide enough that a turned face holds
 * a plate the camera can read (plaza-builder.test.ts checks the figures'
 * size), tall enough to read as an obelisk.
 */
const SHAFT_SIDE = 1.3;
const SHAFT_BOTTOM = 1.28;
const SHAFT_TOP = 4.1;
const COLLAR_TOP = 4.22;
const PYRAMID_TOP = 4.85;
const TIP_TOP = 5.05;

const GROUND = 'plaza-ground';
const DECOR = 'plaza-decor';
const MONUMENT = 'plaza-monument';
const GATEWAY = 'plaza-gateway';
const GLOW = 'plaza-glow';

/** The face text for one figure: the figure as the plate's title, its caption below. */
export function plazaFaceText(figure: string | null, caption: string): string {
  return `${figure ?? PLAZA_UNKNOWN_FIGURE}\n${caption}`;
}

/**
 * Build the plaza into the street's groups. Returns null, adding nothing, on
 * a map without plaza paving.
 */
export function buildPlaza(map: DistrictMap, labels: LabelFactory, res: ResourceBag, parts: PlazaParts): PlazaView | null {
  if (!hasPlaza(map)) return null;
  const floor = parts.floorHeight;
  const fixtures = PLAZA_FIXTURES.filter((piece) => standsOnPlinth(map, piece));
  const bin = new GeometryBin();
  // D-123: the monument and the table are the plaza's stations; their pieces
  // are copied into one affordance mesh as they are built.
  const shells = createAffordanceShells();
  let affordances: AffordanceSet | null = null;
  let monumentMesh: Mesh | null = null;
  let gatewayMesh: Mesh | null = null;
  try {
    pave(map, floor, bin);
    for (const piece of fixtures) {
      switch (piece.kind) {
        case 'monument':
          monument(piece, floor, shells.record(PLAZA_MONUMENT_STATION, bin));
          break;
        case 'table':
          table(piece, floor, shells.record(PLAZA_SHELLS_STATION, bin));
          break;
        case 'arch-post':
          gatewayPost(piece, floor, bin);
          break;
        case 'planter':
          planter(piece, floor, bin);
          break;
        case 'tree':
          tree(piece, floor, bin);
          break;
        case 'bench':
          bench(piece, floor, bin);
          break;
        case 'lamp':
          lamp(piece, floor, bin);
          break;
      }
    }
    const posts = fixtures.filter((piece) => piece.kind === 'arch-post');
    if (posts.length === 2) lintel(posts, bin);

    const groundMaterial = res.material(standardMaterial({ roughness: 0.92 }));
    const decorMaterial = res.material(standardMaterial({ roughness: 0.82 }));
    const monumentMaterial = res.material(standardMaterial({ roughness: 0.55, metalness: 0.05 }));
    const gatewayMaterial = res.material(standardMaterial({ roughness: 0.7 }));
    const glowMaterial = res.material(unlitMaterial());
    flushBin(bin, GROUND, groundMaterial, res, parts.ground, { name: 'plaza:paving', receive: true });
    flushBin(bin, DECOR, decorMaterial, res, parts.ground, { name: 'plaza:decor', cast: true, receive: true });
    monumentMesh = flushBin(bin, MONUMENT, monumentMaterial, res, parts.ground, { name: 'plaza:monument', cast: true, receive: true });
    gatewayMesh = flushBin(bin, GATEWAY, gatewayMaterial, res, parts.ground, { name: 'plaza:gateway', cast: true, receive: true });
    flushBin(bin, GLOW, glowMaterial, res, parts.ground, { name: 'plaza:glow' });
    parts.animators.push((elapsed) => {
      // The lanterns and the monument's light breathe, gently and together.
      glowMaterial.color.setScalar(0.9 + 0.1 * Math.sin((elapsed / 1000) * 1.6));
    });
    affordances = shells.build('plaza:affordances');
    if (affordances) {
      res.disposable(affordances);
      parts.ground.add(affordances.mesh);
      // Both always answer E from the street (D-076), so both always shimmer.
      for (const id of affordances.ids) affordances.setUsable(id, true);
    }
  } finally {
    bin.dispose();
  }

  const addLabel = (label: TextLabel, x: number, y: number, z: number, yaw = 0): TextLabel => {
    parts.textLabels.push(label);
    label.object.position.set(x, y, z);
    label.object.rotation.y = yaw;
    label.object.userData['area'] = 'plaza';
    parts.labels.add(label.object);
    return label;
  };

  // The gateway sign hangs under the lintel, facing the camera (south).
  let sign: TextLabel | null = null;
  const gatewayPosts = fixtures.filter((piece) => piece.kind === 'arch-post');
  if (gatewayPosts.length === 2) {
    const centre = (gatewayPosts[0]!.x + gatewayPosts[1]!.x + 1) / 2;
    const z = gatewayPosts[0]!.y + 0.5;
    sign = addLabel(labels.sign(PLAZA_SIGN_TEXT, PLAZA_THEME.sign), centre, GATEWAY_SIGN_Y, z + 0.17);
    sign.object.userData['plaza'] = 'sign';
  }

  // The monument's three faces: two on the diamond shaft, one on the die.
  const monumentPiece = fixtures.find((piece) => piece.kind === 'monument') ?? null;
  let accounts: TextLabel | null = null;
  let total: TextLabel | null = null;
  let held: TextLabel | null = null;
  if (monumentPiece) {
    const { cx, cz } = centreOf(monumentPiece);
    const out = SHAFT_SIDE / 2 / Math.SQRT2 + 0.012;
    const faceY = (SHAFT_BOTTOM + SHAFT_TOP) / 2;
    accounts = addLabel(
      labels.sign(plazaFaceText(null, PLAZA_FACE_CAPTIONS.accounts), PLAZA_THEME.face),
      cx - out, faceY, cz + out, -Math.PI / 4,
    );
    accounts.object.userData['plaza'] = 'accounts';
    total = addLabel(
      labels.sign(plazaFaceText(null, PLAZA_FACE_CAPTIONS.total), PLAZA_THEME.face),
      cx + out, faceY, cz + out, Math.PI / 4,
    );
    total.object.userData['plaza'] = 'total';
    held = addLabel(
      labels.sign(plazaFaceText(null, PLAZA_FACE_CAPTIONS.held), HELD_STYLE),
      cx, DIE_FACE_Y, cz + DIE_HALF + 0.014,
    );
    held.object.userData['plaza'] = 'held';
  }

  // The shell-game table's card, standing behind the cups so the camera,
  // looking down from the south, sees both.
  const tablePiece = fixtures.find((piece) => piece.kind === 'table') ?? null;
  if (tablePiece) {
    const { cx, cz } = centreOf(tablePiece);
    const card = addLabel(labels.sign(stationLabel(PLAZA_SHELLS_STATION), PLAZA_THEME.card), cx, floor + 1.02, cz - 0.3);
    card.object.userData['plaza'] = 'card';
  }

  if (monumentMesh && monumentPiece) {
    parts.occluders.push(monumentOccluder(monumentMesh, monumentPiece));
  }
  if (gatewayMesh && gatewayPosts.length === 2) {
    const faded: Material[] = [...materialsOf(gatewayMesh), ...(sign ? materialsOf(sign.object) : [])];
    parts.occluders.push(gatewayOccluder(gatewayMesh, gatewayPosts, faded));
  }

  let stats: PlazaStatsPresentation = EMPTY_PLAZA_STATS;
  let heldIndex = 0;
  // D-098: the total has its own shaft face, so the die's held face cycles
  // the top holdings alone, in the Shell's order (one holding sits still).
  const heldFrames = (): readonly string[] => stats.topHoldings ?? [];
  const drawHeld = (): void => {
    const frames = heldFrames();
    const line = frames.length > 0 ? frames[heldIndex % frames.length]! : null;
    held?.setText(plazaFaceText(line, PLAZA_FACE_CAPTIONS.held));
  };
  const draw = (): void => {
    accounts?.setText(plazaFaceText(stats.accounts, PLAZA_FACE_CAPTIONS.accounts));
    total?.setText(plazaFaceText(stats.valueUsd, PLAZA_FACE_CAPTIONS.total));
    drawHeld();
  };
  let lastCycle = 0;
  parts.animators.push((elapsed) => {
    // The top holdings take turns on the held face; one frame stays put.
    const cycle = Math.floor(elapsed / PLAZA_HELD_CYCLE_MS);
    if (cycle !== lastCycle) {
      lastCycle = cycle;
      heldIndex += 1;
      if (heldFrames().length > 1) drawHeld();
    }
  });

  return Object.freeze({
    setStats(next: PlazaStatsPresentation): void {
      stats = normalizePlazaStats(next);
      heldIndex = 0;
      draw();
    },
    affordances,
  });
}

function hasPlaza(map: DistrictMap): boolean {
  return map.tiles.some((row) => row.some((kind) => kind === 'plaza'));
}

/** A fixture is built only where the map made its tiles solid plaza furniture. */
function standsOnPlinth(map: DistrictMap, piece: PlazaFixture): boolean {
  for (let y = piece.y; y < piece.y + piece.height; y++) {
    for (let x = piece.x; x < piece.x + piece.width; x++) {
      if (map.tiles[y]?.[x] !== 'plinth') return false;
    }
  }
  return true;
}

function centreOf(piece: PlazaFixture): { cx: number; cz: number } {
  return { cx: piece.x + piece.width / 2, cz: piece.y + piece.height / 2 };
}

function stationLabel(station: StationId): string {
  return PLAZA_STATIONS.find((candidate) => candidate.station === station)?.label ?? '';
}

function materialsOf(root: Object3D): Material[] {
  const found: Material[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) found.push(material);
  });
  return found;
}

// ---------------------------------------------------------------------------
// Paving
// ---------------------------------------------------------------------------

function isPlazaTile(map: DistrictMap, x: number, y: number): boolean {
  const kind = map.tiles[y]?.[x];
  return kind === 'plaza' || kind === 'plinth';
}

/**
 * Sandstone slabs on every plaza tile, a darker frame along the edge, a ring
 * of setts round the monument, and an edge kerb wherever the plaza meets
 * grass or the map's edge. The pavement side is flush: you walk straight in.
 */
function pave(map: DistrictMap, floor: number, bin: GeometryBin): void {
  const { x: x0, y: y0, width, height } = PLAZA_AREA;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      if (!isPlazaTile(map, x, y)) continue;
      bin.add(GROUND, flatQuad(x, y, x + 1, y + 1, floor), PLAZA_THEME.grout);
      const edge = x === x0 || y === y0 || x === x0 + width - 1 || y === y0 + height - 1;
      const seed = hash01(x, y, 701);
      const tone = edge ? PLAZA_THEME.border : seed < 0.5 ? PLAZA_THEME.slab : PLAZA_THEME.slabAlt;
      // Two slabs per tile, laid in alternating directions: a basket weave.
      const g = 0.025;
      if ((x + y) % 2 === 0) {
        bin.add(GROUND, flatQuad(x + g, y + g, x + 0.5 - g / 2, y + 1 - g, floor + 0.004), jitterColor(tone, seed, 0.02));
        bin.add(GROUND, flatQuad(x + 0.5 + g / 2, y + g, x + 1 - g, y + 1 - g, floor + 0.004), jitterColor(tone, hash01(x, y, 702), 0.02));
      } else {
        bin.add(GROUND, flatQuad(x + g, y + g, x + 1 - g, y + 0.5 - g / 2, floor + 0.004), jitterColor(tone, seed, 0.02));
        bin.add(GROUND, flatQuad(x + g, y + 0.5 + g / 2, x + 1 - g, y + 1 - g, floor + 0.004), jitterColor(tone, hash01(x, y, 702), 0.02));
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (isPlazaTile(map, nx, ny) || map.tiles[ny]?.[nx] === 'pavement') continue;
        const k = 0.12;
        const top = floor + 0.03;
        const kerb =
          dx === 1 ? boxGeometry(x + 1 - k, 0, y, x + 1, top, y + 1)
            : dx === -1 ? boxGeometry(x, 0, y, x + k, top, y + 1)
              : dy === 1 ? boxGeometry(x, 0, y + 1 - k, x + 1, top, y + 1)
                : boxGeometry(x, 0, y, x + 1, top, y + k);
        bin.add(GROUND, kerb, PLAZA_THEME.kerb);
      }
    }
  }
  // Setts in a ring round the monument, just proud of the slabs.
  const monumentPiece = PLAZA_FIXTURES.find((piece) => piece.kind === 'monument');
  if (monumentPiece) {
    const { cx, cz } = centreOf(monumentPiece);
    const segments = 24;
    const inner = 1.95;
    const outer = 2.25;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      const quad: [number, number][] = [
        [cx + Math.cos(a) * inner, cz + Math.sin(a) * inner],
        [cx + Math.cos(a) * outer, cz + Math.sin(a) * outer],
        [cx + Math.cos(b) * outer, cz + Math.sin(b) * outer],
        [cx + Math.cos(b) * inner, cz + Math.sin(b) * inner],
      ];
      const colour = i % 2 === 0 ? PLAZA_THEME.ring : shade(PLAZA_THEME.ring, 0.05);
      bin.add(GROUND, flatPolygon(quad, floor + 0.007), colour);
    }
  }
}

// ---------------------------------------------------------------------------
// The monument
// ---------------------------------------------------------------------------

const DIE_HALF = 0.95;
const DIE_BOTTOM = 0.44;
const DIE_TOP = 1.2;
const DIE_FACE_Y = (DIE_BOTTOM + DIE_TOP) / 2;
/** The held face spans the die's south face. */
const HELD_STYLE = Object.freeze({ ...PLAZA_THEME.face, width: 1.66, height: 0.6 });
const GATEWAY_SIGN_Y = 2.86;

/**
 * Two steps, a die, a square shaft turned 45 degrees so two of its faces look
 * at the camera, a burnt-orange collar and a pyramidion tipped with light.
 */
function monument(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const { cx, cz } = centreOf(piece);
  const hx = piece.width / 2;
  const hz = piece.height / 2;
  const step = (inset: number, y0: number, y1: number, colour: Paint): void => {
    bin.add(MONUMENT, boxGeometry(cx - hx + inset, y0, cz - hz + inset, cx + hx - inset, y1, cz + hz - inset), colour);
  };
  step(0.05, floor, 0.26, PLAZA_THEME.monumentStep);
  step(0.3, 0.26, 0.44, shade(PLAZA_THEME.monumentStep, -0.03));
  bin.add(MONUMENT, boxGeometry(cx - DIE_HALF, DIE_BOTTOM, cz - DIE_HALF, cx + DIE_HALF, DIE_TOP, cz + DIE_HALF), PLAZA_THEME.monument);
  bin.add(MONUMENT, boxGeometry(cx - DIE_HALF - 0.05, DIE_TOP, cz - DIE_HALF - 0.05, cx + DIE_HALF + 0.05, SHAFT_BOTTOM, cz + DIE_HALF + 0.05), PLAZA_THEME.monumentTrim);
  const shaft = new BoxGeometry(SHAFT_SIDE, SHAFT_TOP - SHAFT_BOTTOM, SHAFT_SIDE)
    .rotateY(Math.PI / 4)
    .translate(cx, (SHAFT_BOTTOM + SHAFT_TOP) / 2, cz);
  bin.add(MONUMENT, shaft, PLAZA_THEME.monument);
  const collar = new BoxGeometry(SHAFT_SIDE + 0.1, COLLAR_TOP - SHAFT_TOP, SHAFT_SIDE + 0.1)
    .rotateY(Math.PI / 4)
    .translate(cx, (SHAFT_TOP + COLLAR_TOP) / 2, cz);
  bin.add(GLOW, collar, PLAZA_THEME.glow);
  // A four-sided cone's corners lie on the axes, like the turned shaft's.
  const pyramid = new ConeGeometry((SHAFT_SIDE + 0.1) / Math.SQRT2, PYRAMID_TOP - COLLAR_TOP, 4)
    .translate(cx, (COLLAR_TOP + PYRAMID_TOP) / 2, cz);
  bin.add(MONUMENT, pyramid, PLAZA_THEME.monumentTrim);
  const tip = new OctahedronGeometry(0.11, 0).scale(1, 1.4, 1).translate(cx, PYRAMID_TOP + (TIP_TOP - PYRAMID_TOP) / 2, cz);
  bin.add(GLOW, tip, PLAZA_THEME.glow);
}

function monumentOccluder(mesh: Mesh, piece: PlazaFixture): PlazaOccluder {
  const box = new Box3().setFromObject(mesh);
  const bounds: OccluderBounds = Object.freeze({
    minX: piece.x,
    maxX: piece.x + piece.width,
    minZ: piece.y,
    maxZ: piece.y + piece.height,
    height: Math.max(TIP_TOP, box.max.y),
  });
  return Object.freeze({
    kind: 'plaza',
    part: 'monument',
    object: mesh,
    bounds,
    setOpacity: createOpacityFader(materialsOf(mesh)),
  });
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

const POST_TOP = 3.3;
const LINTEL_TOP = 3.55;

function gatewayPost(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const { cx, cz } = centreOf(piece);
  bin.add(GATEWAY, boxGeometry(cx - 0.3, floor, cz - 0.3, cx + 0.3, floor + 0.3, cz + 0.3), PLAZA_THEME.monumentStep);
  bin.add(GATEWAY, boxGeometry(cx - 0.22, floor + 0.3, cz - 0.22, cx + 0.22, POST_TOP, cz + 0.22), PLAZA_THEME.monument);
  // A lantern on each post, above the lintel.
  bin.add(GATEWAY, boxGeometry(cx - 0.13, LINTEL_TOP, cz - 0.13, cx + 0.13, LINTEL_TOP + 0.05, cz + 0.13), PLAZA_THEME.monumentTrim);
  bin.add(GLOW, sphereGeometry(cx, LINTEL_TOP + 0.17, cz, 0.12, { widthSegments: 8, heightSegments: 5 }), PLAZA_THEME.lamp);
}

/**
 * The lintel across both posts, its orange line, and the two rods the sign
 * hangs from. Its underside is well above head height over the opening.
 */
function lintel(posts: readonly PlazaFixture[], bin: GeometryBin): void {
  const west = centreOf(posts[0]!);
  const east = centreOf(posts[1]!);
  const z = west.cz;
  bin.add(GATEWAY, boxGeometry(west.cx - 0.3, POST_TOP, z - 0.2, east.cx + 0.3, LINTEL_TOP, z + 0.2), PLAZA_THEME.monument);
  bin.add(GLOW, boxGeometry(west.cx - 0.3, POST_TOP + 0.1, z + 0.2, east.cx + 0.3, POST_TOP + 0.14, z + 0.212), PLAZA_THEME.glow);
  const half = PLAZA_THEME.sign.width / 2 - 0.35;
  const centre = (west.cx + east.cx) / 2;
  for (const dx of [-half, half]) {
    bin.add(GATEWAY, boxGeometry(centre + dx - 0.025, GATEWAY_SIGN_Y + PLAZA_THEME.sign.height / 2, z + 0.1, centre + dx + 0.025, POST_TOP, z + 0.16), PLAZA_THEME.iron);
  }
}

function gatewayOccluder(mesh: Mesh, posts: readonly PlazaFixture[], materials: readonly Material[]): PlazaOccluder {
  const box = new Box3().setFromObject(mesh);
  const post = (piece: PlazaFixture): OccluderBounds =>
    Object.freeze({ minX: piece.x + 0.2, maxX: piece.x + 0.8, minZ: piece.y + 0.2, maxZ: piece.y + 0.8, height: LINTEL_TOP });
  const signBottom = GATEWAY_SIGN_Y - PLAZA_THEME.sign.height / 2;
  const span: OccluderBounds = Object.freeze({
    minX: box.min.x,
    maxX: box.max.x,
    minZ: posts[0]!.y + 0.25,
    maxZ: posts[0]!.y + 0.75,
    minY: signBottom,
    height: box.max.y,
  });
  return Object.freeze({
    kind: 'plaza',
    part: 'gateway',
    object: mesh,
    bounds: Object.freeze({ ...span, minY: 0 }),
    boxes: Object.freeze([post(posts[0]!), post(posts[1]!), span]),
    setOpacity: createOpacityFader(materials),
  });
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

/**
 * The shell-game table: a round wooden top on an iron pedestal, three
 * upturned cups in a row and a glinting note beside them.
 */
function table(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const { cx, cz } = centreOf(piece);
  bin.add(DECOR, cylinderGeometry(cx, floor, cz, 0.24, 0.3, 0.06, 10), PLAZA_THEME.iron);
  bin.add(DECOR, cylinderGeometry(cx, floor + 0.06, cz, 0.06, 0.07, 0.62, 8), PLAZA_THEME.iron);
  bin.add(DECOR, cylinderGeometry(cx, floor + 0.68, cz, 0.44, 0.42, 0.06, 14), PLAZA_THEME.wood);
  for (const dx of [-0.24, 0, 0.24]) {
    bin.add(DECOR, cylinderGeometry(cx + dx, floor + 0.74, cz - 0.05, 0.07, 0.1, 0.17, 10), PLAZA_THEME.cup);
    bin.add(DECOR, cylinderGeometry(cx + dx, floor + 0.765, cz - 0.05, 0.096, 0.1, 0.03, 10), PLAZA_THEME.glow);
  }
  bin.add(GLOW, cylinderGeometry(cx + 0.3, floor + 0.74, cz + 0.2, 0.05, 0.05, 0.012, 10), PLAZA_THEME.lamp);
}

/** A stone planter box of shrubs and flowers, filling its row of tiles. */
function planter(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const x0 = piece.x + 0.08;
  const x1 = piece.x + piece.width - 0.08;
  const z0 = piece.y + 0.12;
  const z1 = piece.y + piece.height - 0.12;
  bin.add(DECOR, boxGeometry(x0, floor, z0, x1, floor + 0.44, z1), PLAZA_THEME.stone);
  bin.add(DECOR, boxGeometry(x0 - 0.03, floor + 0.44, z0 - 0.03, x1 + 0.03, floor + 0.5, z1 + 0.03), PLAZA_THEME.stoneDark);
  bin.add(DECOR, boxGeometry(x0 + 0.06, floor + 0.44, z0 + 0.06, x1 - 0.06, floor + 0.47, z1 - 0.06), PLAZA_THEME.soil);
  const count = Math.max(2, Math.round((x1 - x0) / 0.62));
  for (let i = 0; i < count; i++) {
    const seed = hash01(piece.x * 7 + i, piece.y, 711);
    const x = x0 + ((i + 0.5) / count) * (x1 - x0);
    const z = (z0 + z1) / 2 + (seed - 0.5) * 0.12;
    const r = 0.22 + seed * 0.08;
    bin.add(
      DECOR,
      new IcosahedronGeometry(r, 0).scale(1, 0.8, 1).translate(x, floor + 0.47 + r * 0.6, z),
      jitterColor(seed < 0.5 ? PALETTE.hedge : PALETTE.hedgeLight, seed, 0.04),
    );
    const flower = pick(PALETTE.flowers, hash01(piece.x, i, 712));
    bin.add(DECOR, sphereGeometry(x + 0.16, floor + 0.62, z + 0.12, 0.05, { widthSegments: 5, heightSegments: 3 }), flower);
  }
}

/**
 * A round tree in a stone tub. The canopy starts above head height, so it may
 * reach over the paving around it.
 */
function tree(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const { cx, cz } = centreOf(piece);
  const seed = hash01(piece.x, piece.y, 721);
  bin.add(DECOR, cylinderGeometry(cx, floor, cz, 0.42, 0.36, 0.42, 10), PLAZA_THEME.stone);
  bin.add(DECOR, cylinderGeometry(cx, floor + 0.42, cz, 0.44, 0.44, 0.05, 10), PLAZA_THEME.stoneDark);
  bin.add(DECOR, cylinderGeometry(cx, floor + 0.43, cz, 0.36, 0.36, 0.05, 10), PLAZA_THEME.soil);
  bin.add(DECOR, cylinderGeometry(cx, floor + 0.45, cz, 0.08, 0.11, 1.9, 6), PALETTE.trunk);
  const canopy = pick(PALETTE.canopies.slice(0, 4), seed);
  bin.add(DECOR, new IcosahedronGeometry(0.82, 0).scale(1, 0.9, 1).translate(cx, floor + 2.98, cz), jitterColor(canopy, seed, 0.04));
  bin.add(
    DECOR,
    new IcosahedronGeometry(0.5, 0).translate(cx + (seed - 0.5) * 0.5, floor + 3.55, cz + 0.12),
    jitterColor(shade(canopy, 0.04), seed, 0.04),
  );
}

/** A wooden bench on iron legs, its seat facing `facing`, its back behind it. */
function bench(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const facing: PlazaFacing = piece.facing ?? 'north';
  const alongX = facing === 'north' || facing === 'south';
  const inset = 0.1;
  const a0 = (alongX ? piece.x : piece.y) + inset;
  const a1 = (alongX ? piece.x + piece.width : piece.y + piece.height) - inset;
  // Across the bench: 0 at its back edge, 1 at the front, measured into the tile.
  const back = facing === 'north' ? piece.y + piece.height : facing === 'south' ? piece.y : facing === 'west' ? piece.x + piece.width : piece.x;
  const toward = facing === 'north' || facing === 'west' ? -1 : 1;
  const across = (t: number): number => back + toward * t;
  const box = (along0: number, along1: number, t0: number, t1: number, y0: number, y1: number, colour: number): void => {
    const c0 = across(Math.min(t0, t1));
    const c1 = across(Math.max(t0, t1));
    const geometry = alongX
      ? boxGeometry(along0, floor + y0, c0, along1, floor + y1, c1)
      : boxGeometry(c0, floor + y0, along0, c1, floor + y1, along1);
    bin.add(DECOR, geometry, colour);
  };
  // Legs at both ends, then the seat slats, then the back.
  for (const at of [a0 + 0.08, a1 - 0.14]) {
    box(at, at + 0.06, 0.18, 0.62, 0, 0.4, PLAZA_THEME.iron);
    box(at, at + 0.06, 0.1, 0.18, 0, 0.9, PLAZA_THEME.iron);
  }
  for (const [t0, t1] of [[0.2, 0.33], [0.36, 0.49], [0.52, 0.65]] as const) {
    box(a0, a1, t0, t1, 0.4, 0.45, PLAZA_THEME.wood);
  }
  box(a0, a1, 0.1, 0.16, 0.55, 0.66, PLAZA_THEME.woodDark);
  box(a0, a1, 0.1, 0.16, 0.74, 0.86, PLAZA_THEME.woodDark);
}

/** A park lamp: an iron post with a warm glass globe. */
function lamp(piece: PlazaFixture, floor: number, bin: GeometryBin): void {
  const { cx, cz } = centreOf(piece);
  bin.add(DECOR, cylinderGeometry(cx, floor, cz, 0.13, 0.16, 0.22, 8), PLAZA_THEME.iron);
  bin.add(DECOR, cylinderGeometry(cx, floor + 0.22, cz, 0.045, 0.06, 2.3, 6), PLAZA_THEME.iron);
  bin.add(DECOR, cylinderGeometry(cx, floor + 2.52, cz, 0.11, 0.08, 0.06, 8), PLAZA_THEME.iron);
  bin.add(GLOW, sphereGeometry(cx, floor + 2.74, cz, 0.18, { widthSegments: 10, heightSegments: 6 }), PLAZA_THEME.lamp);
  bin.add(DECOR, new CylinderGeometry(0.02, 0.15, 0.1, 8).translate(cx, floor + 2.97, cz), PLAZA_THEME.iron);
}
