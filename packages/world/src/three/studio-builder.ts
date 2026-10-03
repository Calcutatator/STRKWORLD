import { Color, Group, RingGeometry } from 'three';
import type { BufferGeometry, Mesh, MeshBasicMaterial } from 'three';
import {
  avatarStudioTileRole,
  gardenNookRect,
  studioFigureTargetId,
  isAvatarStudioSolidAt,
  isGardenNookBed,
  type AvatarStudioDefinition,
  type AvatarStudioFigure,
  type GardenNookPalette,
} from '../avatar-studio.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { PIXELS_PER_UNIT } from './coords.js';
import {
  GeometryBin,
  ResourceBag,
  GARDEN_THEME,
  boxGeometry,
  coneGeometry,
  cylinderGeometry,
  faceBox,
  faceQuad,
  faceToWorld,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  mixHex,
  pick,
  shade,
  sphereGeometry,
  unlitMaterial,
} from './palette.js';
import { createAffordanceShells, type AffordanceSet } from './affordance.js';
import {
  createInteriorShell,
  type InteriorOccluder,
  type InteriorShell,
  type InteriorWall,
} from './room-builder.js';
import type {
  AvatarFigure,
  AvatarFigureFactory,
  AvatarMotion,
  LabelFactory,
  StudioView,
  TextLabel,
} from './types.js';

/**
 * The Garden in 3D (D-048, D-059, D-134).
 *
 * The dressing room is a walled garden: lawns and flagged lanes inside a
 * clipped hedge, the gate back to the street in the north wall, and sixteen
 * nooks — one per look — each planted and furnished for the character who
 * stands in it. A nook is five tiles across and three deep: a planted back
 * bed carrying its backdrop, a bed either side carrying its two signature
 * props, and in the middle the figure on a stepping plinth with the lawn
 * open in front of it, so E works exactly as it did.
 *
 * Everything the garden is made of goes into the shell's three floor bins —
 * lit `floor`, unlit `glow` and additive `light` — or into a wall's own bins,
 * so the whole garden merges into the same handful of meshes the old room
 * used. Only the drifting motes are a mesh of their own, and they are one.
 *
 * D-123: the figure in reach lights no ring on the floor. Every figure
 * shimmers faintly and the one the interaction system chooses glows
 * (three/affordance.ts), from one affordance mesh for the whole Garden.
 */

/** Plinth height; figures stand on it, and it is walked over. */
export const STUDIO_PAD_TOP = 0.04;

/** Nothing a nook plants may reach walking height over a walkable tile. */
const PROP_CEILING = 1.8;

const IDLE: AvatarMotion = Object.freeze({ moving: false, sprinting: false });

interface FigureView {
  readonly def: AvatarStudioFigure;
  readonly figure: AvatarFigure;
}

export interface AvatarStudioOptions {
  /** D-123: still sparkles and a steady lantern when the player asks for less motion. */
  readonly reducedMotion?: () => boolean;
  /**
   * D-129's coarse-pointer screens. The garden then leaves out the drifting
   * motes and the per-tile ground detail, which cost the most for the least
   * on a phone. Read once, when the garden is built.
   */
  readonly lowDetail?: boolean;
}

export function buildAvatarStudio(
  definition: AvatarStudioDefinition,
  figures: AvatarFigureFactory,
  labels: LabelFactory,
  origin: { readonly x: number; readonly y: number } = ROOM_ORIGIN,
  options: AvatarStudioOptions = {},
): StudioView {
  const res = new ResourceBag();
  // Copy the origin now: a caller mutating its object later must not move the Garden.
  const ox = origin.x / PIXELS_PER_UNIT;
  const oz = origin.y / PIXELS_PER_UNIT;
  const lowDetail = options.lowDetail === true;
  const group = new Group();
  group.name = 'avatar-studio';
  group.position.set(ox, 0, oz);

  const views: FigureView[] = [];
  const created: AvatarFigure[] = [];
  const textLabels: TextLabel[] = [];
  let shell: InteriorShell | null = null;
  let occluders: readonly InteriorOccluder[] = [];
  let affordances: AffordanceSet | null = null;
  let floorLight: MeshBasicMaterial | null = null;
  let floorGlow: MeshBasicMaterial | null = null;
  let motes: Mesh | null = null;
  let moteMaterial: MeshBasicMaterial | null = null;
  try {
    const W = definition.width;
    const H = definition.height;
    shell = createInteriorShell({
      name: group.name,
      width: W,
      height: H,
      originX: ox,
      originZ: oz,
      isWall: (x, y) => x >= 0 && y >= 0 && x < W && y < H && isAvatarStudioSolidAt(definition, x, y),
      floorColor: (x, y) => gardenFloorColor(definition, x, y),
      style: {
        wall: GARDEN_THEME.hedge,
        lower: GARDEN_THEME.wallLower,
        top: GARDEN_THEME.wallTop,
        trim: GARDEN_THEME.trim,
        skirting: GARDEN_THEME.skirting,
        cut: GARDEN_THEME.cut,
      },
      res,
      group,
    });
    gardenGate(shell, definition);
    gardenGrounds(shell, definition, lowDetail);
    hedgeBorder(shell, definition);
    for (const figure of definition.figures) dressNook(shell, figure);

    const shells = createAffordanceShells();
    for (const def of definition.figures) {
      const cx = def.x + def.width / 2;
      const cz = def.y + def.height / 2;
      const figure = figures(def.sprite);
      created.push(figure);
      // Callers own a figure's position and yaw; it faces the camera (+Z) at 0.
      figure.object.position.set(cx, STUDIO_PAD_TOP, cz);
      figure.object.rotation.y = 0;
      figure.object.visible = false;
      group.add(figure.object);
      views.push({ def, figure });
      // Its shell is the figure as it stands: the idle breath moves it by
      // millimetres, well inside the glow's band.
      shells.addObject(studioFigureTargetId(def.figure), figure.object, group);
    }
    affordances = shells.build('avatar-studio:affordances');
    if (affordances) {
      group.add(affordances.mesh);
      // Every figure is always there to wear.
      for (const id of affordances.ids) affordances.setUsable(id, true);
    }

    const north = shell.walls.north;
    const signU = definition.exit.x - 2.5;
    const sign = labels.sign('THE GARDEN', {
      width: 2.4,
      height: 0.5,
      background: GARDEN_THEME.signBackground,
      foreground: GARDEN_THEME.signForeground,
      accent: GARDEN_THEME.signAccent,
    });
    textLabels.push(sign);
    const [sx, sy, sz] = faceToWorld(north.face, signU, 1.55, 0.03);
    sign.object.position.set(sx, sy, sz);
    group.add(sign.object);

    if (!lowDetail) {
      const bin = new GeometryBin();
      gardenMotes(bin, definition);
      moteMaterial = res.material(unlitMaterial({ additive: true }));
      motes = flushBin(bin, 'motes', moteMaterial, res, group, {
        name: 'avatar-studio:motes',
        renderOrder: 2,
      });
      bin.dispose();
    }

    const finished = shell.finish();
    occluders = finished.occluders;
    floorLight = finished.floorLight;
    floorGlow = finished.floorGlow;
  } catch (error) {
    // Preserve the construction error while releasing everything made so far.
    shell?.discard();
    affordances?.dispose();
    for (const figure of created) {
      try {
        figure.dispose();
      } catch {
        // The construction error stays authoritative.
      }
      figure.object.removeFromParent();
    }
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

  // Like the figures, the garden starts hidden: `sync` is its only
  // visibility control (the presenter never toggles `group.visible` itself).
  group.visible = false;
  let figuresVisible = false;
  let elapsed = 0;
  let disposed = false;
  const moteBase = motes?.position.y ?? 0;
  return {
    group,
    occluders,
    affordances,
    sync(state) {
      if (disposed) return;
      const visible = state?.visible === true;
      const groupBefore = group.visible;
      const before = views.map((view) => view.figure.object.visible);
      try {
        group.visible = visible;
        for (const view of views) view.figure.object.visible = visible;
        figuresVisible = visible;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          if (group.visible !== groupBefore) group.visible = groupBefore;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        views.forEach((view, index) => {
          const figureVisible = before[index]!;
          try {
            if (view.figure.object.visible !== figureVisible) view.figure.object.visible = figureVisible;
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        });
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], 'Garden figure sync rollback failed');
        }
        throw error;
      }
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      const t = elapsed / 1000;
      if (figuresVisible) for (const view of views) view.figure.update(dt, IDLE);
      // D-123: reduced motion keeps the lanterns steady and the motes still.
      let still = false;
      try {
        still = options.reducedMotion?.() === true;
      } catch {
        still = false;
      }
      if (floorLight) floorLight.opacity = still ? 0.9 : 0.8 + 0.2 * Math.sin(t * 1.6);
      if (floorGlow) floorGlow.color.setScalar(still ? 0.95 : 0.85 + 0.15 * Math.sin(t * 2.2));
      if (motes && moteMaterial) {
        motes.position.y = still ? moteBase : moteBase + 0.09 * Math.sin(t * 0.7);
        moteMaterial.opacity = still ? 0.6 : 0.45 + 0.25 * Math.sin(t * 1.1);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      figuresVisible = false;
      const errors: unknown[] = [];
      affordances?.dispose();
      for (const view of views) {
        try {
          view.figure.dispose();
        } catch (error) {
          errors.push(error);
        }
        view.figure.object.removeFromParent();
      }
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
      if (errors.length > 1) throw new AggregateError(errors, 'Garden figure cleanup failed');
    },
  };
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

function gardenFloorColor(definition: AvatarStudioDefinition, x: number, y: number): Color {
  const role = avatarStudioTileRole(definition, x, y);
  const seed = hash01(x, y, 401);
  switch (role) {
    case 'gate':
      return shade(0xbba066, 0.02);
    case 'hedge':
      return jitterColor(GARDEN_THEME.hedgeDark, seed, 0.02);
    case 'bed':
      return jitterColor(GARDEN_THEME.soil, seed, 0.03);
    case 'path':
      // Flagstones, laid in two slightly different greys.
      return jitterColor(shade(0x8e8674, (x + y) % 2 === 0 ? 0.03 : -0.02), seed, 0.025);
    default:
      // Mown lawn, in stripes that follow the lanes.
      return jitterColor(shade(0x4e7a3c, y % 2 === 0 ? 0.035 : -0.02), seed, 0.03);
  }
}

/** The way back to the street (D-048): a rose arch over the gate in the north hedge. */
function gardenGate(shell: InteriorShell, definition: AvatarStudioDefinition): void {
  const exit = definition.exit;
  const north = shell.walls.north;
  const x0 = exit.x;
  const x1 = exit.x + exit.width;
  const top = 2.05;
  const post = GARDEN_THEME.gatePost;
  north.bins.add('body', boxGeometry(x0 - 0.42, 0, 0.2, x0, top, 0.95), post);
  north.bins.add('body', boxGeometry(x1, 0, 0.2, x1 + 0.42, top, 0.95), post);
  north.bins.add('body', boxGeometry(x0 - 0.42, top, 0.1, x1 + 0.42, top + 0.33, 0.95), post);
  // Climbing roses over the arch and up both posts.
  for (let i = 0; i < 22; i++) {
    const t = i / 21;
    const x = x0 - 0.5 + t * (x1 - x0 + 1);
    const y = top + 0.34 + 0.1 * Math.sin(t * Math.PI);
    north.bins.add(
      'body',
      sphereGeometry(x, y, 0.62 + 0.2 * hash01(i, 7, 51), 0.17, { widthSegments: 5, heightSegments: 4 }),
      jitterColor(i % 3 === 0 ? GARDEN_THEME.hedgeLight : GARDEN_THEME.hedge, hash01(i, 3, 52), 0.05),
    );
    if (i % 4 === 1) {
      north.bins.add(
        'body',
        sphereGeometry(x, y + 0.13, 0.7, 0.07, { widthSegments: 5, heightSegments: 3 }),
        0xf0e2e6,
      );
    }
  }
  // A dark backing so the opening glows instead of showing the void behind it.
  north.bins.add('body', boxGeometry(x0, 0, -0.14, x1, top, -0.002), 0x141117);
  north.bins.add('unlit', boxGeometry(x0 - 0.03, 0.08, 0.25, x0, top - 0.08, 0.9), GARDEN_THEME.gate);
  north.bins.add('unlit', boxGeometry(x1, 0.08, 0.25, x1 + 0.03, top - 0.08, 0.9), GARDEN_THEME.gate);
  north.bins.add('unlit', boxGeometry(x0, top - 0.03, 0.25, x1, top, 0.9), GARDEN_THEME.gate);
  const c = new Color(GARDEN_THEME.gate);
  shell.floor.addRGBA('light', faceQuad({ normal: 'z+', plane: 0.02 }, x0, 0, x1, top, 0), (_x, y) => [
    c.r,
    c.g,
    c.b,
    0.62 * (1 - 0.55 * (y / top)),
  ]);
  shell.floor.addRGBA('light', flatQuad(x0, exit.y, x1, exit.y + exit.height + 1.6, 0.012), (_x, _y, z) => [
    c.r,
    c.g,
    c.b,
    0.34 * Math.max(0, 1 - (z - exit.y) / (exit.height + 1.6)),
  ]);
}

/**
 * The lanes and lawns themselves: flagstone joints, mown tufts and the pools
 * of lantern light that fall across them. Everything here is ankle-low, so it
 * lies on walkable ground without ever standing in the way.
 */
function gardenGrounds(
  shell: InteriorShell,
  definition: AvatarStudioDefinition,
  lowDetail: boolean,
): void {
  for (let y = 1; y < definition.height - 1; y++) {
    for (let x = 1; x < definition.width - 1; x++) {
      const role = avatarStudioTileRole(definition, x, y);
      if (role === 'path') {
        // A joint line round each flag, and the odd pale pebble.
        shell.floor.add(
          'floor',
          flatQuad(x + 0.06, y + 0.06, x + 0.94, y + 0.94, 0.006),
          jitterColor(GARDEN_THEME.gravel, hash01(x, y, 611), 0.03),
        );
        continue;
      }
      if (role !== 'lawn' || lowDetail) continue;
      // Tufts of grass and the odd daisy, all below ankle height.
      for (let i = 0; i < 3; i++) {
        const tx = x + 0.2 + 0.6 * hash01(x, y * 7 + i, 621);
        const tz = y + 0.2 + 0.6 * hash01(x * 5 + i, y, 622);
        const h = 0.06 + 0.06 * hash01(x + i, y, 623);
        shell.floor.add(
          'floor',
          coneGeometry(tx, 0, tz, 0.07, h, 4),
          jitterColor(GARDEN_THEME.hedgeLight, hash01(x, y + i, 624), 0.05),
        );
      }
      if (hash01(x, y, 625) > 0.86) {
        shell.floor.add(
          'glow',
          sphereGeometry(x + 0.5, 0.075, y + 0.5, 0.05, { widthSegments: 5, heightSegments: 3 }),
          0xf4f0e2,
        );
      }
    }
  }
}

/**
 * The planting against the hedge: a flower border all the way round, a
 * lantern every few tiles and a clipped topiary cone between them. All of it
 * stands on the hedge's own tile ring, which is solid, in the strip the wall
 * itself does not fill.
 */
function hedgeBorder(shell: InteriorShell, definition: AvatarStudioDefinition): void {
  for (const wall of [shell.walls.north, shell.walls.west, shell.walls.east]) {
    for (const [a, b] of wall.spans) {
      border(wall, a + 0.2, b - 0.2, Math.round(a * 7 + (wall.side === 'east' ? 31 : 11)));
    }
  }
  // The south ledge is knee-high so the camera looks over it: only a low
  // ribbon of planting goes there.
  const H = definition.height;
  for (let x = 1; x < definition.width - 1; x += 1) {
    const seed = hash01(x, H, 631);
    shell.south.add(
      'body',
      sphereGeometry(x + 0.5, 0.22, H - 0.72, 0.2, { widthSegments: 6, heightSegments: 4, scaleY: 0.7 }),
      jitterColor(GARDEN_THEME.hedge, seed, 0.05),
    );
    if (seed > 0.6) {
      shell.south.add(
        'body',
        sphereGeometry(x + 0.5, 0.36, H - 0.72, 0.08, { widthSegments: 5, heightSegments: 3 }),
        pick(GARDEN_THEME.blooms, hash01(x, 2, 632)),
      );
    }
  }
}

function border(wall: InteriorWall, u0: number, u1: number, seed: number): void {
  if (u1 - u0 < 0.8) return;
  const face = wall.face;
  const depth = Math.min(0.4, wall.depth);
  // The soil strip the border is planted in.
  wall.bins.add('body', faceBox(face, u0, 0, 0, u1, 0.07, depth), GARDEN_THEME.soil);
  let index = 0;
  for (let u = u0 + 0.35; u < u1 - 0.2; u += 0.7, index++) {
    const h = hash01(seed, index, 641);
    if (index % 7 === 3) {
      // A lantern on a post, the garden's light between the nooks.
      const [x, , z] = faceToWorld(face, u, 0, depth * 0.42);
      wall.bins.add('body', cylinderGeometry(x, 0, z, 0.045, 0.06, 1.42, 6), GARDEN_THEME.iron);
      wall.bins.add('body', boxGeometry(x - 0.12, 1.42, z - 0.12, x + 0.12, 1.66, z + 0.12), GARDEN_THEME.iron);
      wall.bins.add('unlit', sphereGeometry(x, 1.54, z, 0.085, { widthSegments: 6, heightSegments: 4 }), GARDEN_THEME.lantern);
      wall.bins.add('body', coneGeometry(x, 1.66, z, 0.17, 0.14, 6), GARDEN_THEME.iron);
      continue;
    }
    if (index % 7 === 0) {
      // A clipped cone of box.
      const [x, , z] = faceToWorld(face, u, 0, depth * 0.2);
      wall.bins.add('body', coneGeometry(x, 0.05, z, 0.26, 1.05, 7), jitterColor(GARDEN_THEME.hedge, h, 0.04));
      continue;
    }
    const [x, , z] = faceToWorld(face, u, 0, depth * (0.18 + 0.12 * h));
    const height = 0.22 + 0.2 * h;
    wall.bins.add('body', sphereGeometry(x, height, z, 0.2, { widthSegments: 6, heightSegments: 4, scaleY: 0.8 }), jitterColor(GARDEN_THEME.hedgeLight, h, 0.05));
    wall.bins.add(
      'body',
      sphereGeometry(x, height + 0.16, z, 0.075, { widthSegments: 5, heightSegments: 3 }),
      pick(GARDEN_THEME.blooms, hash01(seed, index, 642)),
    );
  }
}

/** Fireflies and pollen over the lanes, a mesh of their own so they can drift. */
function gardenMotes(bin: GeometryBin, definition: AvatarStudioDefinition): void {
  const magic = definition.figures.find((figure) => figure.kind === 'moonCircle');
  for (let i = 0; i < 150; i++) {
    const x = 1.4 + hash01(i, 1, 701) * (definition.width - 2.8);
    const z = 1.4 + hash01(i, 2, 702) * (definition.height - 2.8);
    const y = 1.95 + hash01(i, 3, 703) * 1.25;
    bin.add(
      'motes',
      sphereGeometry(x, y, z, 0.035 + 0.03 * hash01(i, 4, 704), { widthSegments: 4, heightSegments: 3 }),
      hash01(i, 5, 705) > 0.6 ? GARDEN_THEME.lantern : GARDEN_THEME.mote,
    );
  }
  // Thicker over the mage's circle, where the garden is at its most magical.
  if (!magic) return;
  const rect = gardenNookRect(magic);
  for (let i = 0; i < 40; i++) {
    const x = rect.x + 0.3 + hash01(i, 6, 706) * (rect.width - 0.6);
    const z = rect.y + 0.2 + hash01(i, 7, 707) * (rect.height - 0.4);
    const y = 1.95 + hash01(i, 8, 708) * 0.9;
    bin.add('motes', sphereGeometry(x, y, z, 0.05, { widthSegments: 4, heightSegments: 3 }), magic.palette.bloom);
  }
}

// ---------------------------------------------------------------------------
// The nooks
// ---------------------------------------------------------------------------

/** One nook's frame: where its beds are, and how to plant them. */
interface Nook {
  /** Nook rect origin. */
  readonly x0: number;
  readonly z0: number;
  /** Figure centre. */
  readonly cx: number;
  readonly cz: number;
  readonly p: GardenNookPalette;
  readonly seed: number;
  /** A lit solid, into the merged garden mesh. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number | Color): void;
  cyl(x: number, y: number, z: number, rt: number, rb: number, h: number, colour: number | Color, segments?: number): void;
  cone(x: number, y: number, z: number, r: number, h: number, colour: number | Color, segments?: number): void;
  ball(x: number, y: number, z: number, r: number, colour: number | Color, scaleY?: number): void;
  /** A self-lit solid: flame, rune, crystal, ember. */
  lit(geometry: BufferGeometry, colour: number | Color): void;
  /** A pool of coloured light on the ground. */
  pool(x: number, z: number, radius: number, colour: number, strength: number): void;
}

function dressNook(shell: InteriorShell, figure: AvatarStudioFigure): void {
  const rect = gardenNookRect(figure);
  const x0 = rect.x;
  const z0 = rect.y;
  const cx = figure.x + figure.width / 2;
  const cz = figure.y + figure.height / 2;
  const seed = figure.figure;
  const nook: Nook = {
    x0,
    z0,
    cx,
    cz,
    p: figure.palette,
    seed,
    box: (ax, ay, az, bx, by, bz, colour) =>
      shell.floor.add('floor', boxGeometry(ax, ay, az, bx, Math.min(by, PROP_CEILING), bz), colour),
    cyl: (x, y, z, rt, rb, h, colour, segments = 8) =>
      shell.floor.add('floor', cylinderGeometry(x, y, z, rt, rb, h, segments), colour),
    cone: (x, y, z, r, h, colour, segments = 7) =>
      shell.floor.add('floor', coneGeometry(x, y, z, r, h, segments), colour),
    ball: (x, y, z, r, colour, scaleY) =>
      shell.floor.add(
        'floor',
        sphereGeometry(x, y, z, r, { widthSegments: 6, heightSegments: 4, ...(scaleY === undefined ? {} : { scaleY }) }),
        colour,
      ),
    lit: (geometry, colour) => shell.floor.add('glow', geometry, colour),
    pool: (x, z, radius, colour, strength) => {
      const c = new Color(colour);
      shell.floor.addRGBA('light', flatQuad(x - radius, z - radius, x + radius, z + radius, 0.014), (px, _py, pz) => [
        c.r,
        c.g,
        c.b,
        strength * Math.max(0, 1 - Math.hypot(px - x, pz - z) / radius),
      ]);
    },
  };

  // Turned earth over every bed tile, and the plinth the figure stands on.
  for (let dz = 0; dz < rect.height; dz++) {
    for (let dx = 0; dx < rect.width; dx++) {
      const tx = x0 + dx;
      const tz = z0 + dz;
      if (!isGardenNookBed(figure, tx, tz)) continue;
      shell.floor.add(
        'floor',
        flatQuad(tx, tz, tx + 1, tz + 1, 0.05),
        jitterColor(GARDEN_THEME.soil, hash01(tx, tz, 651), 0.03),
      );
    }
  }
  plinth(shell, cx, cz, figure.palette);
  nook.pool(cx, cz + 0.6, 1.5, figure.palette.accent, 0.2);

  // The hedge shoulders either end of the back bed, with the vignette's own
  // backdrop between them.
  nook.box(x0 + 0.04, 0, z0 + 0.08, x0 + 1.1, 1.2, z0 + 0.94, jitterColor(GARDEN_THEME.hedge, hash01(seed, 1, 661), 0.04));
  nook.box(x0 + 3.9, 0, z0 + 0.08, x0 + 4.96, 1.2, z0 + 0.94, jitterColor(GARDEN_THEME.hedge, hash01(seed, 2, 661), 0.04));

  vignette(nook, figure);
}

/** A walk-on stepping plinth, a lit rim and the figure's own colour in it. */
function plinth(shell: InteriorShell, cx: number, cz: number, palette: GardenNookPalette): void {
  shell.floor.add('floor', cylinderGeometry(cx, 0, cz, 0.42, 0.46, STUDIO_PAD_TOP, 20), GARDEN_THEME.pad);
  shell.floor.add(
    'glow',
    new RingGeometry(0.36, 0.42, 24).rotateX(-Math.PI / 2).translate(cx, STUDIO_PAD_TOP + 0.003, cz),
    mixHex(GARDEN_THEME.padRim, palette.accent, 0.45),
  );
}

/** The two side beds' centres, where a nook's signature props stand. */
function leftBed(nook: Nook): [number, number] {
  return [nook.x0 + 0.5, nook.z0 + 1.5];
}
function rightBed(nook: Nook): [number, number] {
  return [nook.x0 + 4.5, nook.z0 + 1.5];
}

/** A lantern on a side bed: every nook keeps one, so none of them is dark. */
function nookLantern(nook: Nook, x: number, z: number, colour: number): void {
  nook.cyl(x, 0.05, z, 0.04, 0.05, 0.95, GARDEN_THEME.iron, 6);
  nook.box(x - 0.11, 1.0, z - 0.11, x + 0.11, 1.22, z + 0.11, GARDEN_THEME.iron);
  nook.lit(sphereGeometry(x, 1.11, z, 0.08, { widthSegments: 6, heightSegments: 4 }), colour);
  nook.cone(x, 1.22, z, 0.14, 0.12, GARDEN_THEME.iron, 6);
  nook.pool(x, z + 0.3, 1.1, colour, 0.16);
}

/** A clump of flowers over a bed, in the nook's own bloom colour. */
function bedFlowers(nook: Nook, x: number, z: number, colour: number, count = 7): void {
  for (let i = 0; i < count; i++) {
    const fx = x - 0.33 + 0.66 * hash01(nook.seed, i, 671);
    const fz = z - 0.33 + 0.66 * hash01(nook.seed, i, 672);
    const h = 0.22 + 0.22 * hash01(nook.seed, i, 673);
    nook.cyl(fx, 0.05, fz, 0.018, 0.022, h, GARDEN_THEME.hedgeLight, 4);
    nook.ball(fx, 0.05 + h, fz, 0.065, jitterColor(colour, hash01(nook.seed, i, 674), 0.07));
  }
}

/** A back-bed backdrop panel: the trellis or wall a vignette hangs itself on. */
function backPanel(nook: Nook, colour: number | Color, height = 1.35): void {
  const x = nook.x0 + 1.15;
  const x1 = nook.x0 + 3.85;
  // Against the back of the bed, between the hedge shoulders: everything the
  // vignette hangs on it then stands in front of it, towards the player.
  nook.box(x, 0, nook.z0 + 0.1, x1, height, nook.z0 + 0.28, colour);
  for (let i = 0; i <= 5; i++) {
    const px = x + ((x1 - x) * i) / 5;
    nook.box(px - 0.05, 0, nook.z0 + 0.1, px + 0.05, height, nook.z0 + 0.34, colour);
  }
}

function vignette(nook: Nook, figure: AvatarStudioFigure): void {
  const [lx, lz] = leftBed(nook);
  const [rx, rz] = rightBed(nook);
  const p = nook.p;
  const bz = nook.z0 + 0.5;
  const bx = nook.x0 + 2.5;
  switch (figure.kind) {
    // ---- the cosy looks -------------------------------------------------
    case 'trailhead': {
      // A camp at the head of the trail: a signpost, a fire and a pack.
      backPanel(nook, GARDEN_THEME.woodDark, 0.4);
      nook.cyl(bx, 0.05, bz, 0.07, 0.08, 1.7, GARDEN_THEME.wood, 6);
      for (const [dy, dir] of [[1.5, 1], [1.18, -1]] as const) {
        nook.box(bx + (dir > 0 ? 0.06 : -0.72), dy, bz - 0.05, bx + (dir > 0 ? 0.72 : -0.06), dy + 0.2, bz + 0.05, GARDEN_THEME.wood);
      }
      nook.box(bx - 0.03, 0.9, bz - 0.02, bx + 0.42, 1.12, bz + 0.02, p.primary);
      nookLantern(nook, rx, rz, GARDEN_THEME.lantern);
      // The campfire: a ring of stones, crossed logs and an ember glow.
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        nook.ball(lx + 0.36 * Math.cos(a), 0.09, lz + 0.36 * Math.sin(a), 0.1, GARDEN_THEME.stone, 0.7);
      }
      nook.box(lx - 0.26, 0.05, lz - 0.05, lx + 0.26, 0.14, lz + 0.05, GARDEN_THEME.woodDark);
      nook.box(lx - 0.05, 0.05, lz - 0.26, lx + 0.05, 0.14, lz + 0.26, GARDEN_THEME.woodDark);
      nook.lit(coneGeometry(lx, 0.14, lz, 0.17, 0.34, 6), 0xffa23c);
      nook.pool(lx, lz, 1.2, 0xffa23c, 0.3);
      break;
    }
    case 'workshop': {
      // The cat mechanic's tool board, bench and a cat asleep on the crates.
      backPanel(nook, GARDEN_THEME.woodDark, 1.3);
      for (let i = 0; i < 5; i++) {
        const tx = nook.x0 + 1.45 + i * 0.55;
        nook.box(tx - 0.035, 0.6, nook.z0 + 0.6, tx + 0.035, 1.18, nook.z0 + 0.66, GARDEN_THEME.steel);
        nook.box(tx - 0.11, 0.6, nook.z0 + 0.6, tx + 0.11, 0.72, nook.z0 + 0.66, p.accent);
      }
      // The bench, with a vice on the end.
      nook.box(lx - 0.45, 0.05, lz - 0.3, lx + 0.45, 0.62, lz + 0.3, GARDEN_THEME.wood);
      nook.box(lx + 0.15, 0.62, lz - 0.12, lx + 0.4, 0.82, lz + 0.12, GARDEN_THEME.iron);
      nook.box(lx - 0.3, 0.62, lz - 0.1, lx - 0.05, 0.7, lz + 0.1, p.accent);
      // Crates, and the cat.
      nook.box(rx - 0.42, 0.05, rz - 0.38, rx + 0.3, 0.52, rz + 0.34, GARDEN_THEME.wood);
      nook.box(rx - 0.2, 0.52, rz - 0.3, rx + 0.42, 0.88, rz + 0.3, shade(GARDEN_THEME.wood, -0.05));
      nook.ball(rx + 0.11, 0.98, rz, 0.17, p.bloom, 0.75);
      nook.ball(rx - 0.05, 1.0, rz, 0.11, p.bloom);
      nook.cone(rx - 0.11, 1.06, rz - 0.07, 0.05, 0.1, p.bloom, 4);
      nook.cone(rx - 0.11, 1.06, rz + 0.07, 0.05, 0.1, p.bloom, 4);
      nook.box(rx + 0.26, 0.9, rz - 0.03, rx + 0.42, 0.96, rz + 0.03, p.bloom);
      nookLantern(nook, lx, lz - 0.02, p.accent);
      break;
    }
    case 'fernGlade': {
      // Birches, ferns and a mossy stump: the ranger's quiet corner.
      for (let i = 0; i < 4; i++) {
        const tx = nook.x0 + 1.4 + i * 0.75;
        nook.cyl(tx, 0.05, bz, 0.09, 0.11, 1.75, 0xe4e2d6, 6);
        for (let k = 0; k < 3; k++) {
          nook.box(tx - 0.1, 0.5 + k * 0.42, bz - 0.11, tx + 0.1, 0.56 + k * 0.42, bz + 0.11, 0x4a4238);
        }
      }
      for (let i = 0; i < 9; i++) {
        const fx = nook.x0 + 1.3 + (i / 8) * 2.4;
        nook.cone(fx, 0.05, nook.z0 + 0.72, 0.17, 0.62, p.primary, 5);
      }
      nook.ball(lx, 0.12, lz, 0.4, GARDEN_THEME.stone, 0.62);
      nook.ball(lx - 0.1, 0.3, lz - 0.08, 0.26, GARDEN_THEME.hedgeLight, 0.4);
      nook.cyl(rx, 0.05, rz, 0.3, 0.34, 0.46, GARDEN_THEME.woodDark, 9);
      nook.box(rx - 0.22, 0.51, rz - 0.16, rx + 0.22, 0.78, rz + 0.16, p.accent);
      nook.box(rx - 0.24, 0.66, rz - 0.18, rx + 0.24, 0.72, rz + 0.18, GARDEN_THEME.wood);
      bedFlowers(nook, rx, rz + 0.08, p.bloom, 5);
      break;
    }
    case 'herbary': {
      // The elder's herb garden: a drying rack, raised beds and a hive.
      backPanel(nook, GARDEN_THEME.wood, 1.5);
      for (let i = 0; i < 7; i++) {
        const hx = nook.x0 + 1.35 + i * 0.4;
        nook.box(hx - 0.07, 0.95, nook.z0 + 0.62, hx + 0.07, 1.34, nook.z0 + 0.76, jitterColor(p.primary, hash01(nook.seed, i, 681), 0.08));
      }
      for (let r = 0; r < 3; r++) {
        nook.box(nook.x0 + 1.3, 0.05, nook.z0 + 0.14 + r * 0.17, nook.x0 + 3.7, 0.2 + 0.05 * r, nook.z0 + 0.26 + r * 0.17, jitterColor(p.bloom, hash01(nook.seed, r, 682), 0.08));
      }
      nook.box(lx - 0.42, 0.05, lz - 0.34, lx + 0.42, 0.3, lz + 0.34, GARDEN_THEME.wood);
      bedFlowers(nook, lx, lz, p.bloom, 6);
      for (let i = 0; i < 4; i++) {
        nook.cyl(rx, 0.05 + i * 0.19, rz, 0.3 - i * 0.03, 0.32 - i * 0.03, 0.17, i % 2 ? 0xe7d9a8 : 0xd8c48a, 8);
      }
      nook.cone(rx, 0.81, rz, 0.3, 0.16, GARDEN_THEME.woodDark, 8);
      nookLantern(nook, lx, lz + 0.22, GARDEN_THEME.lantern);
      break;
    }
    case 'scriptorium': {
      // The scholar's outdoor study: a shelf niche, a lectern and a sundial.
      backPanel(nook, GARDEN_THEME.stone, 1.6);
      for (let row = 0; row < 3; row++) {
        const y = 0.45 + row * 0.38;
        nook.box(nook.x0 + 1.25, y, nook.z0 + 0.5, nook.x0 + 3.75, y + 0.05, nook.z0 + 0.72, GARDEN_THEME.wood);
        for (let i = 0; i < 11; i++) {
          const bxx = nook.x0 + 1.32 + i * 0.22;
          nook.box(bxx, y + 0.05, nook.z0 + 0.52, bxx + 0.15, y + 0.05 + 0.2 + 0.08 * hash01(nook.seed, i + row, 691), nook.z0 + 0.7, pick(GARDEN_THEME.blooms, hash01(nook.seed, i * 3 + row, 692)));
        }
      }
      nook.cyl(lx, 0.05, lz, 0.1, 0.16, 0.9, GARDEN_THEME.wood, 6);
      nook.box(lx - 0.3, 0.9, lz - 0.22, lx + 0.3, 0.98, lz + 0.22, GARDEN_THEME.wood);
      nook.box(lx - 0.28, 0.98, lz - 0.2, lx + 0.28, 1.04, lz + 0.2, 0xf6f2e4);
      nook.lit(flatQuad(lx - 0.26, lz - 0.18, lx + 0.26, lz + 0.18, 1.05), p.accent);
      nook.cyl(rx, 0.05, rz, 0.16, 0.22, 0.86, GARDEN_THEME.stone, 8);
      nook.cyl(rx, 0.91, rz, 0.3, 0.3, 0.06, GARDEN_THEME.stoneDark, 12);
      nook.box(rx - 0.03, 0.97, rz - 0.18, rx + 0.03, 1.28, rz + 0.14, p.accent);
      bedFlowers(nook, rx, rz + 0.1, p.bloom, 4);
      break;
    }
    case 'tinkerYard': {
      // The small mechanic's yard: copper pipes, a pinwheel and cogs.
      backPanel(nook, GARDEN_THEME.woodDark, 0.5);
      for (let i = 0; i < 8; i++) {
        const px = nook.x0 + 1.3 + i * 0.33;
        nook.cyl(px, 0.05, bz, 0.09, 0.09, 0.7 + 0.72 * hash01(nook.seed, i, 701), mixHex(p.accent, GARDEN_THEME.brass, 0.6), 7);
      }
      nook.cyl(lx, 0.05, lz, 0.05, 0.07, 1.25, GARDEN_THEME.iron, 6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        nook.box(lx + 0.3 * Math.cos(a) - 0.07, 1.25 + 0.3 * Math.sin(a) - 0.07, lz - 0.02, lx + 0.3 * Math.cos(a) + 0.07, 1.25 + 0.3 * Math.sin(a) + 0.07, lz + 0.02, i % 2 ? p.primary : p.bloom);
      }
      for (let i = 0; i < 3; i++) {
        nook.cyl(rx - 0.1 + i * 0.08, 0.05 + i * 0.1, rz, 0.3 - i * 0.07, 0.3 - i * 0.07, 0.09, GARDEN_THEME.brass, 10);
      }
      nook.box(rx + 0.04, 0.05, rz + 0.22, rx + 0.42, 0.38, rz + 0.44, p.primary);
      nook.cyl(rx + 0.44, 0.22, rz + 0.33, 0.03, 0.05, 0.2, GARDEN_THEME.steel, 5);
      nookLantern(nook, rx, rz - 0.22, p.bloom);
      break;
    }
    case 'woodpile': {
      // The woodsman's clearing: split logs, a chopping block and a fir.
      for (let row = 0; row < 4; row++) {
        for (let i = 0; i < 9; i++) {
          const lxx = nook.x0 + 1.25 + i * 0.3;
          nook.cyl(lxx, 0.05 + row * 0.29, bz, 0.14, 0.14, 0.27, jitterColor(GARDEN_THEME.wood, hash01(nook.seed, i * 4 + row, 711), 0.06), 7);
        }
      }
      nook.cyl(lx, 0.05, lz, 0.33, 0.36, 0.58, GARDEN_THEME.woodDark, 9);
      nook.box(lx - 0.03, 0.63, lz - 0.03, lx + 0.03, 1.12, lz + 0.03, GARDEN_THEME.wood);
      nook.box(lx - 0.17, 1.0, lz - 0.04, lx + 0.06, 1.2, lz + 0.04, GARDEN_THEME.steel);
      nook.cone(rx, 0.05, rz, 0.44, 1.75, p.primary, 8);
      nook.ball(rx - 0.2, 0.12, rz + 0.22, 0.16, GARDEN_THEME.stone, 0.7);
      break;
    }
    case 'duelLawn': {
      // The duellist's lawn: a rose trellis, a rapier stand and a lamp.
      backPanel(nook, p.primary, 1.55);
      for (let i = 0; i < 14; i++) {
        const rxx = nook.x0 + 1.25 + (i / 13) * 2.5;
        nook.ball(rxx, 0.5 + 0.9 * hash01(nook.seed, i, 721), nook.z0 + 0.64, 0.11, p.bloom);
      }
      nook.box(lx - 0.3, 0.05, lz - 0.1, lx + 0.3, 0.14, lz + 0.1, GARDEN_THEME.wood);
      for (const dx of [-0.16, 0.16]) {
        nook.box(lx + dx - 0.02, 0.14, lz - 0.02, lx + dx + 0.02, 1.3, lz + 0.02, GARDEN_THEME.steel);
        nook.box(lx + dx - 0.07, 1.0, lz - 0.03, lx + dx + 0.07, 1.06, lz + 0.03, p.accent);
      }
      nookLantern(nook, rx, rz, p.accent);
      bedFlowers(nook, rx, rz + 0.1, p.bloom, 5);
      break;
    }
    // ---- the battle looks -----------------------------------------------
    case 'whetstone': {
      // The swordsman's yard: a sword rack, a grindstone and a dummy.
      backPanel(nook, GARDEN_THEME.stoneDark, 1.45);
      for (let i = 0; i < 4; i++) {
        const sx = nook.x0 + 1.45 + i * 0.6;
        nook.box(sx - 0.035, 0.45, nook.z0 + 0.58, sx + 0.035, 1.3, nook.z0 + 0.64, GARDEN_THEME.steel);
        nook.box(sx - 0.1, 0.45, nook.z0 + 0.58, sx + 0.1, 0.52, nook.z0 + 0.64, p.accent);
      }
      nook.box(lx - 0.32, 0.05, lz - 0.2, lx + 0.32, 0.5, lz + 0.2, GARDEN_THEME.wood);
      nook.cyl(lx, 0.78, lz, 0.3, 0.3, 0.1, GARDEN_THEME.stone, 12);
      nook.box(lx - 0.03, 0.5, lz - 0.03, lx + 0.03, 0.83, lz + 0.03, GARDEN_THEME.iron);
      nook.cyl(rx, 0.05, rz, 0.1, 0.14, 0.8, GARDEN_THEME.wood, 6);
      nook.box(rx - 0.24, 0.85, rz - 0.14, rx + 0.24, 1.3, rz + 0.14, 0xcbb485);
      nook.box(rx - 0.44, 1.0, rz - 0.08, rx + 0.44, 1.12, rz + 0.08, 0xcbb485);
      nook.lit(sphereGeometry(rx, 1.2, rz + 0.15, 0.05, { widthSegments: 5, heightSegments: 3 }), p.accent);
      break;
    }
    case 'shadowBower': {
      // The rogue's bower: ivy, a knife board and a cat in the dark.
      backPanel(nook, 0x24231f, 1.5);
      for (let i = 0; i < 18; i++) {
        nook.ball(nook.x0 + 1.25 + (i % 9) * 0.31, 0.6 + Math.floor(i / 9) * 0.46, nook.z0 + 0.62, 0.15, jitterColor(0x2f4030, hash01(nook.seed, i, 731), 0.05), 0.8);
      }
      nook.box(bx - 0.34, 0.72, nook.z0 + 0.56, bx + 0.34, 1.4, nook.z0 + 0.63, GARDEN_THEME.wood);
      nook.box(bx - 0.1, 1.0, nook.z0 + 0.52, bx + 0.1, 1.12, nook.z0 + 0.57, p.accent);
      for (const dx of [-0.22, 0.06, 0.24]) {
        nook.box(bx + dx - 0.015, 0.9 + Math.abs(dx), nook.z0 + 0.46, bx + dx + 0.015, 1.05 + Math.abs(dx), nook.z0 + 0.56, GARDEN_THEME.steel);
      }
      nook.cyl(lx, 0.05, lz, 0.04, 0.05, 0.9, GARDEN_THEME.iron, 6);
      nook.box(lx - 0.1, 0.95, lz - 0.1, lx + 0.1, 1.14, lz + 0.1, 0x23221e);
      nook.lit(sphereGeometry(lx, 1.02, lz + 0.09, 0.05, { widthSegments: 5, heightSegments: 3 }), p.bloom);
      nook.pool(lx, lz + 0.25, 0.8, p.bloom, 0.18);
      nook.ball(rx, 0.22, rz, 0.22, 0x25241f, 0.7);
      nook.ball(rx - 0.16, 0.3, rz, 0.13, 0x25241f);
      nook.cone(rx - 0.2, 0.38, rz - 0.07, 0.05, 0.11, 0x25241f, 4);
      nook.cone(rx - 0.2, 0.38, rz + 0.07, 0.05, 0.11, 0x25241f, 4);
      nook.lit(sphereGeometry(rx - 0.27, 0.32, rz - 0.05, 0.025, { widthSegments: 4, heightSegments: 3 }), p.accent);
      nook.lit(sphereGeometry(rx - 0.27, 0.32, rz + 0.05, 0.025, { widthSegments: 4, heightSegments: 3 }), p.accent);
      bedFlowers(nook, rx, rz + 0.1, p.bloom, 4);
      break;
    }
    case 'archery': {
      // The archer's range: two straw butts, a bow stand and a quiver barrel.
      for (const dx of [-0.75, 0.75]) {
        nook.cyl(bx + dx, 0.05, bz, 0.42, 0.42, 0.26, p.accent, 12);
        nook.box(bx + dx - 0.42, 0.31, bz - 0.06, bx + dx + 0.42, 1.15, bz + 0.06, p.accent);
        nook.cyl(bx + dx, 0.73, bz - 0.09, 0.3, 0.3, 0.04, 0xf2efe2, 14);
        nook.cyl(bx + dx, 0.73, bz - 0.11, 0.14, 0.14, 0.03, 0xd8524a, 12);
        for (let i = 0; i < 3; i++) {
          nook.box(bx + dx - 0.1 + i * 0.09, 0.68 + i * 0.05, bz - 0.5, bx + dx - 0.08 + i * 0.09, 0.7 + i * 0.05, bz - 0.12, 0xe8e2cc);
        }
      }
      nook.box(bx - 1.6, 0, bz + 0.3, bx + 1.6, 0.12, bz + 0.46, GARDEN_THEME.woodDark);
      nook.box(lx - 0.3, 0.05, lz - 0.08, lx + 0.3, 0.14, lz + 0.08, GARDEN_THEME.wood);
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const a = (t - 0.5) * 2.4;
        nook.box(lx - 0.03 + 0.34 * Math.sin(a), 0.2 + t * 1.1, lz - 0.02, lx + 0.03 + 0.34 * Math.sin(a), 0.33 + t * 1.1, lz + 0.02, p.primary);
      }
      nook.cyl(rx, 0.05, rz, 0.28, 0.3, 0.62, GARDEN_THEME.wood, 10);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        nook.box(rx + 0.15 * Math.cos(a) - 0.02, 0.67, rz + 0.15 * Math.sin(a) - 0.02, rx + 0.15 * Math.cos(a) + 0.02, 1.2, rz + 0.15 * Math.sin(a) + 0.02, 0xe8e2cc);
      }
      nookLantern(nook, rx, rz + 0.22, GARDEN_THEME.lantern);
      break;
    }
    case 'bastion': {
      // The guardian's post: a shield wall, a brazier and a banner.
      backPanel(nook, GARDEN_THEME.stoneDark, 1.5);
      for (let i = 0; i < 3; i++) {
        const sx = nook.x0 + 1.6 + i * 0.9;
        nook.box(sx - 0.3, 0.55, nook.z0 + 0.56, sx + 0.3, 1.25, nook.z0 + 0.64, p.primary);
        nook.cone(sx, 0.3, nook.z0 + 0.6, 0.3, 0.3, p.primary, 3);
        nook.box(sx - 0.26, 0.86, nook.z0 + 0.5, sx + 0.26, 0.94, nook.z0 + 0.58, p.accent);
      }
      nook.cyl(lx, 0.05, lz, 0.2, 0.28, 0.72, GARDEN_THEME.stone, 8);
      nook.cyl(lx, 0.77, lz, 0.32, 0.26, 0.2, GARDEN_THEME.iron, 10);
      nook.lit(coneGeometry(lx, 0.95, lz, 0.22, 0.4, 7), 0xffa23c);
      nook.pool(lx, lz, 1.3, 0xffa23c, 0.3);
      nook.cyl(rx, 0.05, rz, 0.05, 0.07, 1.6, GARDEN_THEME.wood, 6);
      nook.box(rx + 0.04, 0.72, rz - 0.015, rx + 0.46, 1.6, rz + 0.015, p.bloom);
      nook.ball(rx, 1.68, rz, 0.09, p.accent);
      break;
    }
    case 'moonCircle': {
      // The mage's circle: a rune arch, glowing mushrooms and a crystal.
      for (const dx of [-0.95, 0.95]) {
        nook.box(bx + dx - 0.22, 0, bz - 0.22, bx + dx + 0.22, 1.5, bz + 0.22, GARDEN_THEME.stoneDark);
        nook.lit(boxGeometry(bx + dx - 0.23, 0.5, bz - 0.06, bx + dx - 0.19, 1.1, bz + 0.06), p.bloom);
      }
      nook.box(bx - 1.2, 1.5, bz - 0.2, bx + 1.2, 1.78, bz + 0.2, GARDEN_THEME.stoneDark);
      nook.lit(boxGeometry(bx - 1.0, 1.58, bz - 0.22, bx + 1.0, 1.68, bz - 0.19), p.bloom);
      // A ring of glowing mushrooms round the nook, along the front of the
      // back bed and over both side beds, so the lawn stays clear to walk on.
      for (let i = 0; i < 13; i++) {
        const t = i / 12;
        const mx = i < 9
          ? nook.x0 + 1.2 + (i / 8) * 2.6
          : (i < 11 ? nook.x0 + 0.3 + 0.4 * hash01(nook.seed, i, 761) : nook.x0 + 4.3 + 0.4 * hash01(nook.seed, i, 762));
        const mz = i < 9
          ? nook.z0 + 0.78 + 0.1 * Math.sin(t * Math.PI * 2)
          : nook.z0 + 1.2 + 0.6 * hash01(nook.seed, i, 763);
        nook.cyl(mx, 0.05, mz, 0.035, 0.05, 0.16, 0xe8e2d2, 5);
        nook.lit(sphereGeometry(mx, 0.21, mz, 0.1, { widthSegments: 6, heightSegments: 3, hemisphere: true }), p.bloom);
      }
      bedFlowers(nook, lx, lz, p.bloom, 4);
      nook.cyl(rx, 0.05, rz, 0.22, 0.3, 0.6, GARDEN_THEME.stoneDark, 8);
      nook.lit(coneGeometry(rx, 0.78, rz, 0.16, 0.42, 6), p.bloom);
      nook.lit(coneGeometry(rx, 0.78, rz, 0.16, -0.26, 6), p.bloom);
      nook.pool(rx, rz, 1.5, p.bloom, 0.34);
      nook.pool(nook.cx, nook.cz, 1.6, p.primary, 0.22);
      nookLantern(nook, lx, lz + 0.22, p.bloom);
      break;
    }
    case 'forge': {
      // The smith's forge: a hooded hearth, an anvil and a quench barrel.
      nook.box(nook.x0 + 1.15, 0, nook.z0 + 0.1, nook.x0 + 3.85, 0.7, nook.z0 + 0.92, GARDEN_THEME.stoneDark);
      nook.lit(boxGeometry(nook.x0 + 1.5, 0.7, nook.z0 + 0.28, nook.x0 + 3.5, 0.78, nook.z0 + 0.8), 0xff8a2a);
      nook.box(nook.x0 + 1.15, 1.2, nook.z0 + 0.1, nook.x0 + 3.85, 1.52, nook.z0 + 0.92, GARDEN_THEME.stone);
      nook.box(nook.x0 + 1.9, 0.78, nook.z0 + 0.28, nook.x0 + 3.1, 1.2, nook.z0 + 0.8, GARDEN_THEME.iron);
      nook.pool(bx, nook.z0 + 1.1, 1.9, 0xff8a2a, 0.34);
      // The anvil on its stump, and a hammer leaning on it.
      nook.cyl(lx, 0.05, lz, 0.28, 0.32, 0.4, GARDEN_THEME.woodDark, 9);
      nook.box(lx - 0.3, 0.45, lz - 0.14, lx + 0.3, 0.58, lz + 0.14, GARDEN_THEME.iron);
      nook.box(lx - 0.12, 0.58, lz - 0.1, lx + 0.12, 0.68, lz + 0.1, GARDEN_THEME.iron);
      nook.cone(lx - 0.38, 0.52, lz, 0.08, 0.2, GARDEN_THEME.iron, 5);
      nook.box(lx + 0.18, 0.05, lz + 0.2, lx + 0.24, 0.66, lz + 0.26, GARDEN_THEME.wood);
      nook.box(lx + 0.12, 0.66, lz + 0.15, lx + 0.3, 0.8, lz + 0.31, p.primary);
      // Smithing stones, the quench barrel and a rack of maces and axes.
      nook.cyl(rx - 0.08, 0.05, rz + 0.18, 0.26, 0.28, 0.5, GARDEN_THEME.wood, 10);
      nook.cyl(rx - 0.08, 0.53, rz + 0.18, 0.24, 0.24, 0.03, 0x4a6a74, 10);
      for (let i = 0; i < 3; i++) {
        const sx = rx - 0.26 + i * 0.22;
        nook.ball(sx, 0.1, rz - 0.28, 0.12 - i * 0.02, GARDEN_THEME.stoneDark, 0.7);
      }
      nook.box(rx + 0.2, 0.05, rz - 0.42, rx + 0.3, 1.25, rz - 0.32, GARDEN_THEME.wood);
      nook.box(rx + 0.16, 0.95, rz - 0.44, rx + 0.42, 1.03, rz - 0.3, GARDEN_THEME.wood);
      nook.box(rx + 0.2, 1.03, rz - 0.42, rx + 0.26, 1.42, rz - 0.36, GARDEN_THEME.wood);
      nook.ball(rx + 0.23, 1.46, rz - 0.39, 0.1, p.accent);
      break;
    }
    case 'warCamp': {
      // The berserker's camp: standing stones, a bonfire and a halberd rack.
      for (let i = 0; i < 3; i++) {
        const sx = nook.x0 + 1.5 + i * 1.0;
        nook.box(sx - 0.26, 0, bz - 0.26, sx + 0.26, 1.3 + 0.18 * i, bz + 0.26, jitterColor(GARDEN_THEME.stoneDark, hash01(nook.seed, i, 741), 0.04));
        nook.cone(sx, 0.75, bz - 0.18, 0.24, 0.26, p.primary, 3);
        nook.box(sx - 0.18, 0.9, bz - 0.24, sx + 0.18, 0.98, bz - 0.18, p.accent);
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        nook.ball(lx + 0.36 * Math.cos(a), 0.09, lz + 0.36 * Math.sin(a), 0.12, GARDEN_THEME.stoneDark, 0.7);
      }
      nook.box(lx - 0.3, 0.05, lz - 0.06, lx + 0.3, 0.16, lz + 0.06, GARDEN_THEME.woodDark);
      nook.lit(coneGeometry(lx, 0.14, lz, 0.22, 0.56, 6), 0xff9a2a);
      nook.pool(lx, lz, 1.5, 0xff9a2a, 0.36);
      nook.cyl(rx, 0.05, rz, 0.06, 0.08, 1.5, GARDEN_THEME.wood, 6);
      nook.box(rx - 0.04, 1.5, rz - 0.04, rx + 0.04, 1.76, rz + 0.04, GARDEN_THEME.steel);
      nook.box(rx - 0.2, 1.46, rz - 0.03, rx - 0.04, 1.66, rz + 0.03, GARDEN_THEME.steel);
      for (const dz of [-0.3, 0.3]) {
        nook.cone(rx + 0.3, 0.9, rz + dz, 0.07, 0.3, p.accent, 5);
      }
      break;
    }
    case 'chapterRose': {
      // The knight's rose garden: a white arbour, a bench and a sword stand.
      backPanel(nook, 0xe8e6de, 1.6);
      for (let i = 0; i < 20; i++) {
        const rxx = nook.x0 + 1.25 + (i % 10) * 0.28;
        nook.ball(rxx, 0.6 + Math.floor(i / 10) * 0.52 + 0.2 * hash01(nook.seed, i, 751), nook.z0 + 0.64, 0.12, i % 3 === 0 ? p.bloom : 0xf4f2ea);
      }
      nook.box(lx - 0.44, 0.05, lz - 0.18, lx + 0.44, 0.1, lz + 0.18, GARDEN_THEME.stone);
      nook.box(lx - 0.44, 0.1, lz - 0.2, lx + 0.44, 0.44, lz + 0.2, GARDEN_THEME.stone);
      nook.box(lx - 0.44, 0.44, lz - 0.2, lx + 0.44, 0.5, lz + 0.2, GARDEN_THEME.stoneDark);
      nook.cyl(rx, 0.05, rz, 0.16, 0.22, 0.5, GARDEN_THEME.stone, 8);
      nook.box(rx - 0.03, 0.5, rz - 0.03, rx + 0.03, 1.5, rz + 0.03, GARDEN_THEME.steel);
      nook.box(rx - 0.18, 1.18, rz - 0.03, rx + 0.18, 1.26, rz + 0.03, p.accent);
      nook.ball(rx, 1.56, rz, 0.07, p.accent);
      nookLantern(nook, lx, lz + 0.22, GARDEN_THEME.lantern);
      break;
    }
  }
}
