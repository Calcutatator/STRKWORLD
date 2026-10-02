import { Color, Group, RingGeometry } from 'three';
import type { MeshBasicMaterial } from 'three';
import {
  avatarStudioTileColour,
  studioFigureTargetId,
  isAvatarStudioSolidAt,
  type AvatarStudioDefinition,
  type AvatarStudioFigure,
} from '../avatar-studio.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { PIXELS_PER_UNIT } from './coords.js';
import {
  ResourceBag,
  STUDIO_THEME,
  boxGeometry,
  cylinderGeometry,
  faceBox,
  facePipe,
  faceQuad,
  faceToWorld,
  flatQuad,
  hash01,
  jitterColor,
  pick,
  shade,
  sphereGeometry,
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
 * The hidden Avatar Studio in 3D (D-048, D-059).
 *
 * A dressing room: Hollywood mirrors, rails of clothes, a rug, and one floor
 * pad per figure with the injected avatar standing on it. Pads are walked
 * onto (they are not solid), so they stay 4 cm tall. The return portal glows
 * in the top wall. `sync` keeps the 2D figure layer's contract — figures
 * follow `visible`, rollback on a failed sync, idempotent teardown with no
 * late resurrection — and also shows or hides the room itself, since
 * StudioView has no other visibility control.
 *
 * D-123: the figure in reach no longer lights a ring on the floor. Every
 * figure shimmers faintly and the one the interaction system chooses glows
 * (three/affordance.ts), from one affordance mesh for the whole Studio.
 */

/** Pad height; figures stand on it. */
export const STUDIO_PAD_TOP = 0.04;

const IDLE: AvatarMotion = Object.freeze({ moving: false, sprinting: false });

interface FigureView {
  readonly def: AvatarStudioFigure;
  readonly figure: AvatarFigure;
}

export function buildAvatarStudio(
  definition: AvatarStudioDefinition,
  figures: AvatarFigureFactory,
  labels: LabelFactory,
  origin: { readonly x: number; readonly y: number } = ROOM_ORIGIN,
): StudioView {
  const res = new ResourceBag();
  // Copy the origin now: a caller mutating its object later must not move the Studio.
  const ox = origin.x / PIXELS_PER_UNIT;
  const oz = origin.y / PIXELS_PER_UNIT;
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
      floorColor: (x, y) => studioFloorColor(definition, x, y),
      style: {
        wall: avatarStudioTileColour(definition, 0, 0),
        lower: STUDIO_THEME.wallLower,
        top: STUDIO_THEME.wallTop,
        trim: STUDIO_THEME.trim,
        skirting: STUDIO_THEME.skirting,
        cut: STUDIO_THEME.cut,
      },
      res,
      group,
    });
    returnPortal(shell, definition);
    studioDecor(shell);
    rug(shell, definition);
    for (const figure of definition.figures) pad(shell, figure);

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
    const signU = definition.exit.x - 2.3;
    const sign = labels.sign('AVATAR STUDIO', {
      width: 2.4,
      height: 0.5,
      background: STUDIO_THEME.signBackground,
      foreground: STUDIO_THEME.signForeground,
      accent: STUDIO_THEME.signAccent,
    });
    textLabels.push(sign);
    const [sx, sy, sz] = faceToWorld(north.face, signU, 1.55, 0.03);
    sign.object.position.set(sx, sy, sz);
    group.add(sign.object);

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

  // Like the figures, the room starts hidden: `sync` is the Studio's only
  // visibility control (the presenter never toggles `group.visible` itself).
  group.visible = false;
  let figuresVisible = false;
  let elapsed = 0;
  let disposed = false;
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
          throw new AggregateError([error, ...rollbackErrors], 'Avatar Studio figure sync rollback failed');
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
      if (floorLight) floorLight.opacity = 0.8 + 0.2 * Math.sin(t * 1.6);
      if (floorGlow) floorGlow.color.setScalar(0.85 + 0.15 * Math.sin(t * 2.2));
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
      if (errors.length > 1) throw new AggregateError(errors, 'Avatar Studio figure cleanup failed');
    },
  };
}

function studioFloorColor(definition: AvatarStudioDefinition, x: number, y: number): Color {
  const base = avatarStudioTileColour(definition, x, y);
  const border = x === 0 || y === 0 || x === definition.width - 1 || y === definition.height - 1;
  if (border) return shade(base, -0.02);
  return jitterColor(shade(base, (x + y) % 2 === 0 ? 0.018 : -0.012), hash01(x, y, 401), 0.012);
}

/** The way back to the street (D-048): a lit arch in the top wall over the exit tiles. */
function returnPortal(shell: InteriorShell, definition: AvatarStudioDefinition): void {
  const exit = definition.exit;
  const north = shell.walls.north;
  const x0 = exit.x;
  const x1 = exit.x + exit.width;
  const top = 2.05;
  const trim = STUDIO_THEME.trim;
  north.bins.add('body', boxGeometry(x0 - 0.42, 0, 0.2, x0, top, 0.95), trim);
  north.bins.add('body', boxGeometry(x1, 0, 0.2, x1 + 0.42, top, 0.95), trim);
  north.bins.add('body', boxGeometry(x0 - 0.42, top, 0.1, x1 + 0.42, top + 0.33, 0.95), trim);
  north.bins.add('body', boxGeometry(x0 - 0.3, top + 0.33, 0.2, x1 + 0.3, top + 0.4, 0.85), STUDIO_THEME.wallTop);
  // A dark backing so the opening glows instead of showing the void behind the room.
  north.bins.add('body', boxGeometry(x0, 0, -0.14, x1, top, -0.002), 0x141117);
  north.bins.add('unlit', boxGeometry(x0 - 0.03, 0.08, 0.25, x0, top - 0.08, 0.9), STUDIO_THEME.portal);
  north.bins.add('unlit', boxGeometry(x1, 0.08, 0.25, x1 + 0.03, top - 0.08, 0.9), STUDIO_THEME.portal);
  north.bins.add('unlit', boxGeometry(x0, top - 0.03, 0.25, x1, top, 0.9), STUDIO_THEME.portal);
  const c = new Color(STUDIO_THEME.portal);
  shell.floor.addRGBA('light', faceQuad({ normal: 'z+', plane: 0.02 }, x0, 0, x1, top, 0), (_x, y) => [
    c.r,
    c.g,
    c.b,
    0.62 * (1 - 0.55 * (y / top)),
  ]);
  shell.floor.addRGBA('light', flatQuad(x0, exit.y, x1, exit.y + exit.height + 1.2, 0.012), (_x, _y, z) => [
    c.r,
    c.g,
    c.b,
    0.34 * Math.max(0, 1 - (z - exit.y) / (exit.height + 1.2)),
  ]);
}

function studioDecor(shell: InteriorShell): void {
  const north = shell.walls.north;
  const spans = north.spans;
  const left = spans[0];
  const right = spans[spans.length - 1];
  if (left) mirror(north, left[0] + 2.45);
  if (right && right !== left) {
    mirror(north, right[1] - 2.15);
    rail(north, right[0] + 1.0, right[0] + 4.0, 11);
  }
  for (const [index, wall] of [shell.walls.west, shell.walls.east].entries()) {
    for (const [a, b] of wall.spans) {
      rail(wall, a + 1.4, a + 5.2, 20 + index);
      shoeShelf(wall, a + 5.8, b - 0.8, 30 + index);
      for (let u = a + 1; u < b - 0.5; u += 2.2) {
        const [x, , z] = faceToWorld(wall.face, u, 0, 0.3);
        wall.bins.add('body', faceBox(wall.face, u - 0.05, 2.02, 0, u + 0.05, 2.12, 0.3), STUDIO_THEME.rack);
        wall.bins.add('unlit', sphereGeometry(x, 2.0, z, 0.06, { widthSegments: 6, heightSegments: 4 }), STUDIO_THEME.spot);
      }
    }
  }
}

/** A Hollywood mirror: framed glass ringed with bulbs. */
function mirror(wall: InteriorWall, u: number): void {
  const face = wall.face;
  wall.bins.add('body', faceBox(face, u - 0.55, 0.3, 0, u + 0.55, 1.95, 0.06), STUDIO_THEME.rack);
  wall.bins.add('unlit', faceBox(face, u - 0.47, 0.38, 0.06, u + 0.47, 1.87, 0.065), 0xaebcd6);
  wall.bins.add('unlit', faceBox(face, u - 0.47, 1.25, 0.065, u - 0.1, 1.87, 0.068), 0xc7d3ea);
  for (let i = 0; i < 5; i++) {
    const [x, y, z] = faceToWorld(face, u - 0.44 + i * 0.22, 1.91, 0.09);
    wall.bins.add('unlit', sphereGeometry(x, y, z, 0.035, { widthSegments: 6, heightSegments: 4 }), STUDIO_THEME.spot);
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const [x, y, z] = faceToWorld(face, u + side * 0.51, 0.55 + i * 0.3, 0.09);
      wall.bins.add('unlit', sphereGeometry(x, y, z, 0.035, { widthSegments: 6, heightSegments: 4 }), STUDIO_THEME.spot);
    }
  }
}

/** A clothes rail with garments hanging in the wall's decor strip. */
function rail(wall: InteriorWall, u0: number, u1: number, seed: number): void {
  if (u1 - u0 < 0.6) return;
  const face = wall.face;
  const w = Math.min(0.28, wall.depth - 0.1);
  wall.bins.add('body', facePipe(face, u0, u1, 1.62, w, 0.022), 0x9a9aa6);
  for (const u of [u0 + 0.03, u1 - 0.03]) {
    wall.bins.add('body', faceBox(face, u - 0.02, 1.55, 0, u + 0.02, 1.66, w + 0.03), 0x9a9aa6);
  }
  const count = Math.floor((u1 - u0 - 0.2) / 0.36);
  for (let i = 0; i < count; i++) {
    const u = u0 + 0.28 + i * 0.36;
    const colour = pick(STUDIO_THEME.garments, hash01(seed, i, 411));
    const long = hash01(seed, i, 412) < 0.35;
    wall.bins.add('body', faceBox(face, u - 0.13, long ? 0.62 : 0.98, w - 0.1, u + 0.13, 1.58, w + 0.1), colour);
    wall.bins.add('body', faceBox(face, u - 0.2, 1.36, w - 0.09, u + 0.2, 1.56, w + 0.09), shade(colour, -0.05));
  }
}

function shoeShelf(wall: InteriorWall, u0: number, u1: number, seed: number): void {
  if (u1 - u0 < 0.6) return;
  const face = wall.face;
  for (const v of [0.22, 0.52]) {
    wall.bins.add('body', faceBox(face, u0, v, 0, u1, v + 0.035, 0.36), STUDIO_THEME.rack);
    let u = u0 + 0.1;
    let i = 0;
    while (u + 0.24 < u1) {
      const colour = pick(STUDIO_THEME.garments, hash01(seed, i + Math.round(v * 10), 421));
      wall.bins.add('body', faceBox(face, u, v + 0.035, 0.06, u + 0.2, v + 0.13, 0.3), colour);
      u += 0.3;
      i++;
    }
  }
}

/** A rug under the pads, flat on the floor. */
function rug(shell: InteriorShell, definition: AvatarStudioDefinition): void {
  if (definition.figures.length === 0) return;
  const minX = Math.min(...definition.figures.map((figure) => figure.x)) - 0.5;
  const maxX = Math.max(...definition.figures.map((figure) => figure.x + figure.width)) + 0.5;
  const minZ = Math.min(...definition.figures.map((figure) => figure.y)) - 0.6;
  const maxZ = Math.max(...definition.figures.map((figure) => figure.y + figure.height)) + 0.6;
  const x0 = Math.max(1.1, minX);
  const x1 = Math.min(definition.width - 1.1, maxX);
  const z0 = Math.max(1.1, minZ);
  const z1 = Math.min(definition.height - 1.1, maxZ);
  shell.floor.add('floor', flatQuad(x0, z0, x1, z1, 0.004), STUDIO_THEME.rug);
  const b = 0.1;
  shell.floor.add('floor', flatQuad(x0, z0, x1, z0 + b, 0.007), STUDIO_THEME.rugBorder);
  shell.floor.add('floor', flatQuad(x0, z1 - b, x1, z1, 0.007), STUDIO_THEME.rugBorder);
  shell.floor.add('floor', flatQuad(x0, z0 + b, x0 + b, z1 - b, 0.007), STUDIO_THEME.rugBorder);
  shell.floor.add('floor', flatQuad(x1 - b, z0 + b, x1, z1 - b, 0.007), STUDIO_THEME.rugBorder);
}

/** A walk-on pad: a 4 cm disc with a softly lit rim. */
function pad(shell: InteriorShell, figure: AvatarStudioFigure): void {
  const cx = figure.x + figure.width / 2;
  const cz = figure.y + figure.height / 2;
  shell.floor.add('floor', cylinderGeometry(cx, 0, cz, 0.42, 0.44, STUDIO_PAD_TOP, 20), STUDIO_THEME.pad);
  shell.floor.add(
    'glow',
    new RingGeometry(0.36, 0.42, 24).rotateX(-Math.PI / 2).translate(cx, STUDIO_PAD_TOP + 0.003, cz),
    STUDIO_THEME.padRim,
  );
}
