import {
  BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RingGeometry,
} from 'three';
import type { Material, MeshStandardMaterial, Object3D } from 'three';
import type { StationId } from '@strkworld/shared';
import type {
  FixedRoomMap,
  FixedRoomStationDefinition,
  FixedRoomStationPresentation,
} from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { PIXELS_PER_UNIT } from './coords.js';
import {
  EXCHANGE_TICKER,
  GeometryBin,
  PALETTE,
  ResourceBag,
  STATION_LOOKS,
  aoPaint,
  beamGeometry,
  boxGeometry,
  clamp01,
  createOpacityFader,
  createTickerStrip,
  cylinderGeometry,
  faceBox,
  faceDisc,
  facePipe,
  faceToWorld,
  faceTorus,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  mixColor,
  pick,
  roomTheme,
  runsWhere,
  shade,
  sphereGeometry,
  standardMaterial,
  unlitMaterial,
  type Face,
  type Paint,
  type RoomTheme,
  type StationLook,
} from './palette.js';
import type { LabelFactory, Occluder, OccluderBounds, RoomView, TextLabel } from './types.js';

/**
 * Fixed-room interiors as lit dioramas (D-059).
 *
 * The follow camera looks in from the south, so the south wall is a low
 * ledge and the north, east and west walls stand full height, each its own
 * fadeable occluder. Every volume stays on wall or station tiles; the floor
 * the player walks on carries only flat inlays, halos and light. The room is
 * drawn at `origin` (World pixels) over the hidden street.
 */

export const INTERIOR_WALL_HEIGHT = 2.2;
export const INTERIOR_SOUTH_WALL_HEIGHT = 0.4;
/** The wall slab's share of its tile; the rest is a decor strip for shelves and screens. */
export const INTERIOR_WALL_THICKNESS = 0.55;

const STATION_BEACON_Y = 1.42;
const STATION_LABEL_Y = 1.74;
const APRON_COLOUR = 0x2e2629;

type Animator = (elapsedMs: number) => void;

export type InteriorWallSide = 'north' | 'west' | 'east';

/** A wall occluder that also names which wall it fades. */
export interface InteriorOccluder extends Occluder {
  readonly side: InteriorWallSide;
  readonly object: Object3D;
}

export interface InteriorWallStyle {
  readonly wall: number;
  readonly lower: number;
  readonly top: number;
  readonly trim: number;
  readonly skirting: number;
  /** The cutaway end of a tall wall where it meets the low south ledge. */
  readonly cut: number;
}

export interface InteriorWall {
  readonly side: InteriorWallSide;
  /** The wall's inner face; decor stands out of it by up to `depth`. */
  readonly face: Face;
  /** Usable stretches along the face (u), split where the wall has an opening. */
  readonly spans: readonly (readonly [number, number])[];
  readonly depth: number;
  /** Keys: 'body' (lit, vertex coloured) and 'unlit' (self-lit screens and lamps). */
  readonly bins: GeometryBin;
  readonly group: Group;
  /** Extra materials (textured meshes) that fade with this wall. */
  readonly fadeMaterials: Material[];
}

export interface InteriorShellMaterials {
  readonly occluders: readonly InteriorOccluder[];
  /** Floor 'glow' key: unlit inlays; pulse via `color`. */
  readonly floorGlow: MeshBasicMaterial | null;
  /** Floor 'light' key: additive RGBA light pools; pulse via `opacity`. */
  readonly floorLight: MeshBasicMaterial | null;
  readonly southUnlit: MeshBasicMaterial | null;
}

export interface InteriorShell {
  readonly walls: Readonly<Record<InteriorWallSide, InteriorWall>>;
  /** Keys: 'floor' (lit), 'glow' (unlit), 'light' (additive RGBA). */
  readonly floor: GeometryBin;
  /** Keys: 'body' and 'unlit'. */
  readonly south: GeometryBin;
  /** Merge everything into meshes and create one occluder per tall wall. */
  finish(): InteriorShellMaterials;
  /** Release pending geometry when construction fails before `finish`. */
  discard(): void;
}

export interface InteriorShellOptions {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** World-unit position of the root group, for occluder bounds. */
  readonly originX: number;
  readonly originZ: number;
  readonly isWall: (x: number, y: number) => boolean;
  readonly floorColor: (x: number, y: number) => Color;
  readonly style: InteriorWallStyle;
  readonly res: ResourceBag;
  /** Root group, already positioned at the room origin. */
  readonly group: Group;
}

/**
 * Floor, tall north/west/east walls with skirting, wainscot and chair rail,
 * and a low south ledge, all from the tile grid. Shared by the fixed rooms
 * and the Avatar Studio so both read as the same kind of place.
 */
export function createInteriorShell(options: InteriorShellOptions): InteriorShell {
  const { width: W, height: H, res, group, style, name } = options;
  const T = INTERIOR_WALL_THICKNESS;
  const WH = INTERIOR_WALL_HEIGHT;
  const SH = INTERIOR_SOUTH_WALL_HEIGHT;
  const floor = new GeometryBin();
  const south = new GeometryBin();
  const bins: GeometryBin[] = [floor, south];

  const northRuns = runsWhere((x) => options.isWall(x, 0), 0, W);
  const westRuns = runsWhere((y) => options.isWall(0, y), 1, H - 1);
  const eastRuns = runsWhere((y) => options.isWall(W - 1, y), 1, H - 1);
  const southRuns = runsWhere((x) => options.isWall(x, H - 1), 0, W);
  const cornerStart = (start: number, cornerIsWall: boolean) => (start === 1 && cornerIsWall ? T : start);

  const makeWall = (side: InteriorWallSide, face: Face, spans: [number, number][]): InteriorWall => {
    const wallGroup = new Group();
    wallGroup.name = `${name}:wall-${side}`;
    group.add(wallGroup);
    const wallBins = new GeometryBin();
    bins.push(wallBins);
    return {
      side,
      face,
      spans: spans.filter(([a, b]) => b - a > 0.05),
      depth: 1 - T - 0.02,
      bins: wallBins,
      group: wallGroup,
      fadeMaterials: [],
    };
  };
  const walls = {
    north: makeWall(
      'north',
      { normal: 'z+', plane: T },
      northRuns.map(([a, b]) => [Math.max(a, T), Math.min(b, W - T)]),
    ),
    west: makeWall(
      'west',
      { normal: 'x+', plane: T },
      westRuns.map(([a, b]) => [cornerStart(a, options.isWall(0, 0)), b]),
    ),
    east: makeWall(
      'east',
      { normal: 'x-', plane: W - T },
      eastRuns.map(([a, b]) => [cornerStart(a, options.isWall(W - 1, 0)), b]),
    ),
  } as const;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) floor.add('floor', flatQuad(x, y, x + 1, y + 1, 0), options.floorColor(x, y));
  }
  // A dark apron: the room reads as a lit set instead of floating in sky.
  floor.add('apron', flatQuad(-30, -30, W + 30, H + 30, -0.02), APRON_COLOUR);

  for (const [a, b] of northRuns) {
    walls.north.bins.add('body', boxGeometry(a, 0, 0, b, WH, T), aoPaint(style.wall));
    walls.north.bins.add('body', boxGeometry(a, WH, 0, b, WH + 0.07, T + 0.04), style.top);
  }
  for (const [wall, runs, x0, x1, capA, capB] of [
    [walls.west, westRuns, 0, T, 0, T + 0.04],
    [walls.east, eastRuns, W - T, W, W - T - 0.04, W],
  ] as const) {
    const cornerIsWall = options.isWall(wall === walls.west ? 0 : W - 1, 0);
    for (const [a, b] of runs) {
      const z0 = cornerStart(a, cornerIsWall);
      const cut = b === H - 1;
      const z1 = cut ? b - 0.03 : b;
      wall.bins.add('body', boxGeometry(x0, 0, z0, x1, WH, z1), aoPaint(style.wall));
      wall.bins.add('body', boxGeometry(capA, WH, z0, capB, WH + 0.07, b), style.top);
      if (cut) wall.bins.add('body', boxGeometry(x0, 0, z1, x1, WH, b), style.cut);
    }
  }
  for (const wall of Object.values(walls)) {
    for (const [a, b] of wall.spans) {
      wall.bins.add('body', faceBox(wall.face, a, 0, 0, b, 0.13, 0.035), style.skirting);
      wall.bins.add('body', faceBox(wall.face, a, 0.13, 0, b, 0.92, 0.02), style.lower);
      wall.bins.add('body', faceBox(wall.face, a, 0.92, 0, b, 0.98, 0.04), style.trim);
    }
  }
  for (const [a, b] of southRuns) {
    south.add('body', boxGeometry(a, 0, H - 1, b, SH, H), aoPaint(style.wall, 0.05, SH));
    south.add('body', boxGeometry(a, SH, H - 1, b, SH + 0.05, H), style.top);
  }

  let finished = false;
  const discard = (): void => {
    for (const bin of bins) bin.dispose();
  };
  return {
    walls,
    floor,
    south,
    discard,
    finish() {
      if (finished) throw new Error('Interior shell already finished');
      finished = true;
      try {
        const floorMaterial = res.material(standardMaterial({ roughness: 0.78 }));
        flushBin(floor, 'floor', floorMaterial, res, group, { name: `${name}:floor`, receive: true });
        const apronMaterial = res.material(standardMaterial({ roughness: 1 }));
        flushBin(floor, 'apron', apronMaterial, res, group, { name: `${name}:apron`, receive: true });
        const floorGlow = floor.has('glow') ? res.material(unlitMaterial()) : null;
        if (floorGlow) flushBin(floor, 'glow', floorGlow, res, group, { name: `${name}:floor-glow` });
        const floorLight = floor.has('light') ? res.material(unlitMaterial({ additive: true })) : null;
        if (floorLight) flushBin(floor, 'light', floorLight, res, group, { name: `${name}:light`, renderOrder: 2 });
        const southBody = res.material(standardMaterial({ roughness: 0.84 }));
        flushBin(south, 'body', southBody, res, group, { name: `${name}:south-wall`, cast: true, receive: true });
        const southUnlit = south.has('unlit') ? res.material(unlitMaterial()) : null;
        if (southUnlit) flushBin(south, 'unlit', southUnlit, res, group, { name: `${name}:south-wall-lights` });

        const occluders: InteriorOccluder[] = [];
        const { originX: ox, originZ: oz } = options;
        const footprint: Record<InteriorWallSide, Omit<OccluderBounds, 'height'>> = {
          north: { minX: ox, maxX: ox + W, minZ: oz, maxZ: oz + 1 },
          west: { minX: ox, maxX: ox + 1, minZ: oz, maxZ: oz + H - 1 },
          east: { minX: ox + W - 1, maxX: ox + W, minZ: oz, maxZ: oz + H - 1 },
        };
        for (const wall of Object.values(walls)) {
          if (!wall.bins.has('body')) continue;
          const body = res.material(standardMaterial({ roughness: 0.82 }));
          flushBin(wall.bins, 'body', body, res, wall.group, {
            name: `${wall.group.name}:body`,
            cast: true,
            receive: true,
          });
          const fade: Material[] = [body, ...wall.fadeMaterials];
          if (wall.bins.has('unlit')) {
            const unlit = res.material(unlitMaterial());
            flushBin(wall.bins, 'unlit', unlit, res, wall.group, { name: `${wall.group.name}:lights` });
            fade.push(unlit);
          }
          let height = WH + 0.07;
          wall.group.traverse((object) => {
            if (object instanceof Mesh) {
              object.geometry.computeBoundingBox();
              height = Math.max(height, object.geometry.boundingBox?.max.y ?? 0);
            }
          });
          occluders.push(
            Object.freeze({
              side: wall.side,
              object: wall.group,
              bounds: Object.freeze({ ...footprint[wall.side], height }),
              setOpacity: createOpacityFader(fade),
            }),
          );
        }
        return { occluders, floorGlow, floorLight, southUnlit };
      } finally {
        discard();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fixed rooms
// ---------------------------------------------------------------------------

interface StationView {
  readonly station: StationId;
  readonly group: Group;
  readonly accent: MeshStandardMaterial;
  readonly haloFill: MeshBasicMaterial;
  readonly haloEdge: MeshBasicMaterial;
  readonly beacon: Mesh;
  readonly label: TextLabel;
  readonly phase: number;
  labelText: string;
  look: StationLook;
  highlighted: boolean;
}

export function buildFixedRoom(
  map: FixedRoomMap,
  labels: LabelFactory,
  origin: { readonly x: number; readonly y: number } = ROOM_ORIGIN,
): RoomView {
  const res = new ResourceBag();
  const theme = roomTheme(map.building);
  // Copy the origin now: a caller mutating its object later must not move the room.
  const ox = origin.x / PIXELS_PER_UNIT;
  const oz = origin.y / PIXELS_PER_UNIT;
  const group = new Group();
  group.name = `room:${map.building}`;
  group.userData['building'] = map.building;
  group.position.set(ox, 0, oz);

  const textLabels: TextLabel[] = [];
  const stations: StationView[] = [];
  const animators: Animator[] = [];
  let shell: InteriorShell | null = null;
  let finished: InteriorShellMaterials;
  try {
    shell = createInteriorShell({
      name: group.name,
      width: map.width,
      height: map.height,
      originX: ox,
      originZ: oz,
      isWall: (x, y) => map.tiles[y]?.[x] === 'wall',
      floorColor: roomFloorColor(theme, map),
      style: {
        wall: theme.wall,
        lower: theme.wallLower,
        top: theme.wallTop,
        trim: theme.trim,
        skirting: theme.skirting,
        cut: theme.cut,
      },
      res,
      group,
    });
    decorateRoom(theme, shell, map, res, animators);
    exitDecor(map, theme, shell);
    for (const station of map.stations) {
      stations.push(buildStation(station, theme, labels, res, group, textLabels));
    }
    finished = shell.finish();
  } catch (error) {
    shell?.discard();
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

  const { floorGlow, floorLight, southUnlit } = finished;
  animators.push((elapsed) => {
    const t = elapsed / 1000;
    const pulse = 0.85 + 0.15 * Math.sin(t * 1.8);
    if (floorLight) floorLight.opacity = pulse;
    if (southUnlit) southUnlit.color.setScalar(0.8 + 0.2 * Math.sin(t * 1.8));
    if (floorGlow) floorGlow.color.setScalar(0.9 + 0.1 * Math.sin(t * 1.8));
  });

  let elapsed = 0;
  let disposed = false;
  return {
    building: map.building,
    group,
    occluders: finished.occluders,
    setStations(presentations: readonly FixedRoomStationPresentation[]) {
      if (disposed || !Array.isArray(presentations)) return;
      for (const presentation of presentations) {
        const view = stations.find((candidate) => candidate.station === presentation?.station);
        if (view) applyStation(view, presentation);
      }
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      const t = elapsed / 1000;
      for (const view of stations) {
        view.beacon.rotation.y = t * (view.highlighted ? 2.4 : 0.8) + view.phase;
        view.beacon.position.y = STATION_BEACON_Y + Math.sin(t * 2 + view.phase) * 0.04;
        const breathe = view.highlighted ? Math.sin(t * 4.5) : 0;
        view.haloFill.opacity = view.look.haloOpacity * (1 + 0.18 * breathe);
        view.haloEdge.opacity = Math.min(1, view.look.edgeOpacity * (1 + 0.08 * breathe));
        view.accent.emissiveIntensity = view.look.emissiveIntensity * (1 + 0.12 * breathe);
      }
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
      if (errors.length > 1) throw new AggregateError(errors, 'Room disposal failed');
    },
  };
}

function applyStation(view: StationView, presentation: FixedRoomStationPresentation): void {
  const available = presentation.status === 'available';
  const highlighted = presentation.highlighted === true;
  const look = available
    ? highlighted
      ? STATION_LOOKS.highlighted
      : STATION_LOOKS.available
    : highlighted
      ? STATION_LOOKS.lockedHighlighted
      : STATION_LOOKS.locked;
  view.look = look;
  view.highlighted = highlighted;
  view.accent.color.setHex(look.color);
  view.accent.emissive.setHex(look.emissive);
  view.accent.emissiveIntensity = look.emissiveIntensity;
  view.haloFill.color.setHex(look.halo);
  view.haloFill.opacity = look.haloOpacity;
  view.haloEdge.color.setHex(look.halo);
  view.haloEdge.opacity = look.edgeOpacity;
  view.group.userData['status'] = available ? 'available' : 'locked';
  view.group.userData['highlighted'] = highlighted;
  const text =
    typeof presentation.label === 'string' && presentation.label.trim().length > 0
      ? presentation.label
      : view.labelText;
  if (text !== view.labelText) {
    view.labelText = text;
    view.label.setText(text);
  }
}

/** A counter on the station rect, a status beacon, a floating label and the approach halo. */
function buildStation(
  station: FixedRoomStationDefinition,
  theme: RoomTheme,
  labels: LabelFactory,
  res: ResourceBag,
  parent: Group,
  textLabels: TextLabel[],
): StationView {
  const group = new Group();
  group.name = `station:${station.station}`;
  group.userData['station'] = station.station;
  parent.add(group);
  const x0 = station.x + 0.1;
  const x1 = station.x + station.width - 0.1;
  const z0 = station.y + 0.14;
  const z1 = station.y + station.height - 0.1;
  const cx = station.x + station.width / 2;
  const cz = station.y + station.height / 2;

  const accent = res.material(standardMaterial({ vertexColors: false, roughness: 0.5 }));
  const haloFill = res.material(unlitMaterial({ vertexColors: false, transparent: true }));
  const haloEdge = res.material(unlitMaterial({ vertexColors: false, transparent: true }));
  const bin = new GeometryBin();
  try {
    bin.add('body', boxGeometry(x0, 0, z0, x1, 0.92, z1), aoPaint(theme.kioskBase, 0.1));
    bin.add('body', boxGeometry(x0 - 0.05, 0.92, z0 - 0.05, x1 + 0.05, 1, z1 + 0.05), theme.kioskTop);
    bin.add('body', boxGeometry(x0 + 0.03, 0, z1, x1 - 0.03, 0.1, z1 + 0.02), shade(theme.kioskBase, -0.12));
    bin.add('accent', boxGeometry(x0 + 0.12, 0.3, z1, x1 - 0.12, 0.72, z1 + 0.03), 0xffffff);
    stationProps(theme, bin, x0, x1, z0, z1);

    const hx0 = station.x - 1 + 0.04;
    const hx1 = station.x + station.width + 1 - 0.04;
    const hz0 = station.y - 1 + 0.04;
    const hz1 = station.y + station.height + 1 - 0.04;
    const sx0 = station.x;
    const sx1 = station.x + station.width;
    const sz0 = station.y;
    const sz1 = station.y + station.height;
    const fillY = 0.012;
    bin.add('fill', flatQuad(hx0, hz0, hx1, sz0, fillY), 0xffffff);
    bin.add('fill', flatQuad(hx0, sz1, hx1, hz1, fillY), 0xffffff);
    bin.add('fill', flatQuad(hx0, sz0, sx0, sz1, fillY), 0xffffff);
    bin.add('fill', flatQuad(sx1, sz0, hx1, sz1, fillY), 0xffffff);
    const e = 0.06;
    const edgeY = 0.015;
    bin.add('edge', flatQuad(hx0, hz0, hx1, hz0 + e, edgeY), 0xffffff);
    bin.add('edge', flatQuad(hx0, hz1 - e, hx1, hz1, edgeY), 0xffffff);
    bin.add('edge', flatQuad(hx0, hz0 + e, hx0 + e, hz1 - e, edgeY), 0xffffff);
    bin.add('edge', flatQuad(hx1 - e, hz0 + e, hx1, hz1 - e, edgeY), 0xffffff);

    const body = res.material(standardMaterial({ roughness: 0.7 }));
    flushBin(bin, 'body', body, res, group, { name: `${group.name}:counter`, cast: true, receive: true });
    if (bin.has('unlit')) flushBin(bin, 'unlit', res.material(unlitMaterial()), res, group, { name: `${group.name}:screen` });
    flushBin(bin, 'accent', accent, res, group, { name: `${group.name}:status` });
    flushBin(bin, 'fill', haloFill, res, group, { name: `${group.name}:halo`, renderOrder: 1 });
    flushBin(bin, 'edge', haloEdge, res, group, { name: `${group.name}:halo-edge`, renderOrder: 1 });
  } finally {
    bin.dispose();
  }
  const beacon = new Mesh(res.geometry(new OctahedronGeometry(0.14, 0)), accent);
  beacon.name = `${group.name}:beacon`;
  beacon.position.set(cx, STATION_BEACON_Y, cz);
  group.add(beacon);

  const label = labels.floating(station.label, {
    lineHeight: 0.3,
    foreground: theme.labelForeground,
    background: theme.labelBackground,
  });
  textLabels.push(label);
  label.object.position.set(cx, STATION_LABEL_Y, cz);
  label.object.userData['station'] = station.station;
  group.add(label.object);

  const view: StationView = {
    station: station.station,
    group,
    accent,
    haloFill,
    haloEdge,
    beacon,
    label,
    phase: hash01(Math.round(cx * 10), Math.round(cz * 10), 301) * Math.PI * 2,
    labelText: station.label,
    look: STATION_LOOKS.locked,
    highlighted: false,
  };
  // Until the Shell reports otherwise a station is locked (fixed-room.ts).
  applyStation(view, { ...station, status: 'locked', highlighted: false });
  return view;
}

/** Themed props on the counter top (y = 1). */
function stationProps(theme: RoomTheme, bin: GeometryBin, x0: number, x1: number, z0: number, z1: number): void {
  const cz = (z0 + z1) / 2;
  const top = 1;
  switch (theme.decor) {
    case 'bank': {
      const lx = x0 + 0.3;
      bin.add('body', cylinderGeometry(lx, top, cz, 0.08, 0.1, 0.04, 8), theme.trim);
      bin.add('body', cylinderGeometry(lx, top + 0.04, cz, 0.015, 0.015, 0.26, 6), theme.trim);
      bin.add('body', boxGeometry(lx - 0.16, top + 0.26, cz - 0.07, lx + 0.16, top + 0.34, cz + 0.07), 0x2f6b45);
      for (let i = 0; i < 3; i++) {
        bin.add('body', cylinderGeometry(x1 - 0.3 + i * 0.07, top, cz + (i % 2) * 0.06, 0.06, 0.06, 0.05 + i * 0.03, 10), theme.trim);
      }
      break;
    }
    case 'exchange': {
      const cx = (x0 + x1) / 2;
      const face: Face = { normal: 'z+', plane: z0 + 0.12 };
      bin.add('body', boxGeometry(cx - 0.05, top, z0 + 0.06, cx + 0.05, top + 0.1, z0 + 0.14), 0x1b262c);
      bin.add('body', faceBox(face, cx - 0.42, top + 0.08, 0, cx + 0.42, top + 0.52, 0.05), 0x10181c);
      bin.add('unlit', faceBox(face, cx - 0.38, top + 0.12, 0.05, cx + 0.38, top + 0.48, 0.055), 0x0f3a3c);
      for (let i = 0; i < 7; i++) {
        const h = 0.06 + hash01(i, 3, 311) * 0.24;
        const u = cx - 0.32 + i * 0.1;
        bin.add('unlit', faceBox(face, u, top + 0.15, 0.055, u + 0.06, top + 0.15 + h, 0.06), i % 3 === 1 ? 0xff6b5b : 0x54e0a0);
      }
      break;
    }
    case 'post-office': {
      bin.add('body', boxGeometry(x0 + 0.2, top, cz - 0.16, x0 + 0.62, top + 0.3, cz + 0.16), 0xc49a6c);
      bin.add('body', boxGeometry(x0 + 0.38, top + 0.3, cz - 0.165, x0 + 0.44, top + 0.305, cz + 0.165), 0xe8d8b0);
      bin.add('body', boxGeometry(x1 - 0.55, top, cz - 0.12, x1 - 0.2, top + 0.06, cz + 0.12), 0x6d7280);
      bin.add('body', cylinderGeometry(x1 - 0.375, top + 0.06, cz, 0.15, 0.15, 0.02, 12), 0xb8bcc6);
      break;
    }
    case 'bridge': {
      const cx = (x0 + x1) / 2;
      bin.add('unlit', faceTorus({ normal: 'z+', plane: 0 }, 0, 0, 0, 0.22, 0.025, { tubularSegments: 16 }).rotateX(-Math.PI / 2).translate(cx, top + 0.02, cz), theme.exitGlow);
      bin.add('body', boxGeometry(x0 + 0.1, top, z0 + 0.05, x0 + 0.34, top + 0.08, z0 + 0.25), 0x2d3945);
      bin.add('body', boxGeometry(x1 - 0.34, top, z0 + 0.05, x1 - 0.1, top + 0.08, z0 + 0.25), 0x2d3945);
      break;
    }
    case 'plain':
      break;
  }
}

function roomFloorColor(theme: RoomTheme, map: FixedRoomMap): (x: number, y: number) => Color {
  return (x, y) => {
    const tile = map.tiles[y]?.[x];
    const seed = hash01(x, y, 201);
    if (tile === 'wall') return shade(theme.floorB, -0.1);
    if (theme.decor === 'bridge') return jitterColor(hash01(x, y, 202) < 0.5 ? theme.floorA : theme.floorB, seed, 0.02);
    return jitterColor((x + y) % 2 === 0 ? theme.floorA : theme.floorB, seed, theme.decor === 'exchange' ? 0.012 : 0.022);
  };
}

/** The exit: a glowing mat, chevrons pointing out, bollards and a pool of light. */
function exitDecor(map: FixedRoomMap, theme: RoomTheme, shell: InteriorShell): void {
  const exit = map.exit;
  const x0 = exit.x;
  const x1 = exit.x + exit.width;
  const z0 = exit.y;
  const z1 = exit.y + exit.height;
  const glow = theme.exitGlow;
  shell.floor.add('floor', flatQuad(x0 + 0.1, z0 + 0.1, x1 - 0.1, z1 - 0.1, 0.006), 0x3a302a);
  const e = 0.05;
  shell.floor.add('glow', flatQuad(x0 + 0.1, z0 + 0.1, x1 - 0.1, z0 + 0.1 + e, 0.009), glow);
  shell.floor.add('glow', flatQuad(x0 + 0.1, z1 - 0.1 - e, x1 - 0.1, z1 - 0.1, 0.009), glow);
  shell.floor.add('glow', flatQuad(x0 + 0.1, z0 + 0.1, x0 + 0.1 + e, z1 - 0.1, 0.009), glow);
  shell.floor.add('glow', flatQuad(x1 - 0.1 - e, z0 + 0.1, x1 - 0.1, z1 - 0.1, 0.009), glow);
  const c = new Color(glow);
  if (exit.y === map.height - 1) {
    const cx = (x0 + x1) / 2;
    for (const zc of [z0 - 0.62, z0 - 0.28]) chevron(shell.floor, cx, zc, glow);
    for (const bx of [x0 - 0.3, x1 + 0.3]) {
      if (map.tiles[exit.y]?.[Math.floor(bx)] !== 'wall') continue;
      const bz = (z0 + z1) / 2;
      shell.south.add('body', cylinderGeometry(bx, 0, bz, 0.11, 0.13, 0.46, 8), theme.wallTop);
      shell.south.add('unlit', cylinderGeometry(bx, 0.46, bz, 0.09, 0.09, 0.05, 8), glow);
    }
    shell.floor.add('floor', flatQuad(x0 - 0.2, z1, x1 + 0.2, z1 + 0.9, 0), shade(theme.floorB, -0.12));
    shell.floor.addRGBA('light', flatQuad(x0, z0 - 1.6, x1, z1, 0.013), (_x, _y, z) => [
      c.r,
      c.g,
      c.b,
      0.32 * clamp01(1 - (z1 - z) / 2.6),
    ]);
  } else {
    shell.floor.addRGBA('light', flatQuad(x0, z0, x1, z1, 0.013), () => [c.r, c.g, c.b, 0.25]);
  }
}

/** A flat chevron pointing south (+Z). */
function chevron(bin: GeometryBin, cx: number, zc: number, colour: number): void {
  const tip: [number, number] = [cx, zc + 0.14];
  for (const side of [-1, 1]) {
    const end: [number, number] = [cx + side * 0.3, zc - 0.14];
    bin.add(
      'glow',
      flatPolygon([tip, [tip[0], tip[1] - 0.1], [end[0], end[1] - 0.1], end], 0.01),
      colour,
    );
  }
}

// ---------------------------------------------------------------------------
// Room decor
// ---------------------------------------------------------------------------

function decorateRoom(theme: RoomTheme, shell: InteriorShell, map: FixedRoomMap, res: ResourceBag, animators: Animator[]): void {
  switch (theme.decor) {
    case 'bank':
      bankDecor(theme, shell, map);
      return;
    case 'exchange':
      exchangeDecor(theme, shell, map, res, animators);
      return;
    case 'post-office':
      postOfficeDecor(theme, shell, map);
      return;
    case 'bridge':
      bridgeDecor(theme, shell, map, res, animators);
      return;
    case 'plain':
      return;
  }
}

/** Inset line around the walkable floor, one hair inside the walls. */
function perimeterInlay(shell: InteriorShell, map: FixedRoomMap, inset: number, width: number, paint: Paint, key = 'floor'): void {
  const a = 1 + inset;
  const b = map.width - 1 - inset;
  const c = 1 + inset;
  const d = map.height - 1 - inset;
  const y = 0.006;
  shell.floor.add(key, flatQuad(a, c, b, c + width, y), paint);
  shell.floor.add(key, flatQuad(a, d - width, b, d, y), paint);
  shell.floor.add(key, flatQuad(a, c + width, a + width, d - width, y), paint);
  shell.floor.add(key, flatQuad(b - width, c + width, b, d - width, y), paint);
}

/** Centre of the north wall span that a station faces, for decor behind it. */
function stationAnchor(map: FixedRoomMap): number {
  const first = map.stations[0];
  return first ? first.x + first.width / 2 : map.width / 2;
}

function inSpans(wall: InteriorWall, u0: number, u1: number): boolean {
  return wall.spans.some(([a, b]) => u0 >= a - 1e-6 && u1 <= b + 1e-6);
}

/** Marble, pilasters, a gold vault-door emblem, paintings and a red carpet. */
function bankDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomMap): void {
  const north = shell.walls.north;
  const nf = north.face;
  const cream = 0xf6efdd;
  const anchor = stationAnchor(map);
  for (const offset of [-7.7, -5.1, -1.7, 1.7, 5.1, 7.7]) {
    const u = anchor + offset;
    if (!inSpans(north, u - 0.26, u + 0.26)) continue;
    north.bins.add('body', faceBox(nf, u - 0.24, 0, 0, u + 0.24, 0.22, 0.17), theme.wallLower);
    north.bins.add('body', faceBox(nf, u - 0.2, 0.22, 0, u + 0.2, 1.96, 0.14), cream);
    north.bins.add('body', faceBox(nf, u - 0.26, 1.96, 0, u + 0.26, 2.12, 0.18), theme.trim);
  }
  // The vault door behind the teller, gold on steel.
  const vy = 1.2;
  north.bins.add('body', faceDisc(nf, anchor, vy, 0, 0.72, 0.06, 18), 0x9aa3ad);
  north.bins.add('body', faceTorus(nf, anchor, vy, 0.07, 0.72, 0.06, { tubularSegments: 20 }), theme.trim);
  north.bins.add('body', faceTorus(nf, anchor, vy, 0.11, 0.26, 0.035, { tubularSegments: 14 }), theme.trim);
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI;
    const du = Math.cos(angle) * 0.26;
    const dv = Math.sin(angle) * 0.26;
    north.bins.add(
      'body',
      beamGeometry(faceToWorld(nf, anchor - du, vy - dv, 0.11), faceToWorld(nf, anchor + du, vy + dv, 0.11), 0.03, 0.03),
      theme.trim,
    );
  }
  north.bins.add('body', faceDisc(nf, anchor, vy, 0.06, 0.07, 0.08, 10), theme.trim);
  for (const u of [anchor - 3.4, anchor + 3.4]) {
    if (!inSpans(north, u - 0.62, u + 0.62)) continue;
    north.bins.add('body', faceBox(nf, u - 0.62, 1.05, 0, u + 0.62, 1.85, 0.05), theme.trim);
    north.bins.add('body', faceBox(nf, u - 0.52, 1.47, 0.05, u + 0.52, 1.75, 0.06), 0x9cc3e0);
    north.bins.add('body', faceBox(nf, u - 0.52, 1.15, 0.05, u + 0.52, 1.47, 0.06), 0x7fa35e);
    north.bins.add('body', faceDisc(nf, u + 0.25, 1.6, 0.06, 0.07, 0.01, 10), 0xffd27a);
  }
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [a, b] of wall.spans) {
      const windows = [a + (b - a) * 0.3, a + (b - a) * 0.62];
      for (const u of windows) {
        wall.bins.add('body', faceBox(wall.face, u - 0.5, 0.95, 0, u + 0.5, 2.0, 0.06), theme.trim);
        wall.bins.add('unlit', faceBox(wall.face, u - 0.42, 1.03, 0.06, u + 0.42, 1.92, 0.065), 0xcfe3f5);
        wall.bins.add('body', faceBox(wall.face, u - 0.02, 1.03, 0.065, u + 0.02, 1.92, 0.08), theme.trim);
        wall.bins.add('body', faceBox(wall.face, u - 0.42, 1.5, 0.065, u + 0.42, 1.54, 0.08), theme.trim);
      }
      const lamp = (windows[0]! + windows[1]!) / 2;
      wall.bins.add('body', faceBox(wall.face, lamp - 0.05, 1.42, 0, lamp + 0.05, 1.7, 0.06), theme.trim);
      wall.bins.add('unlit', faceBox(wall.face, lamp - 0.08, 1.7, 0.04, lamp + 0.08, 1.9, 0.2), 0xffd9a0);
      pottedPlant(wall, b - 0.5);
    }
  }
  perimeterInlay(shell, map, 0.12, 0.05, theme.floorAccent);
  carpet(shell, map, 0x9e2f35, theme.floorAccent);
}

/** A runner from the exit to the first station in line with it. */
function carpet(shell: InteriorShell, map: FixedRoomMap, colour: number, edge: number): void {
  const exit = map.exit;
  const station = map.stations.find((candidate) => candidate.x < exit.x + exit.width && candidate.x + candidate.width > exit.x);
  const zTop = station ? station.y + station.height + 1 : map.height / 2;
  const x0 = exit.x + 0.15;
  const x1 = exit.x + exit.width - 0.15;
  const zBottom = exit.y;
  if (zBottom - zTop < 0.5) return;
  shell.floor.add('floor', flatQuad(x0, zTop, x1, zBottom, 0.004), colour);
  shell.floor.add('floor', flatQuad(x0, zTop, x0 + 0.06, zBottom, 0.007), edge);
  shell.floor.add('floor', flatQuad(x1 - 0.06, zTop, x1, zBottom, 0.007), edge);
}

function pottedPlant(wall: InteriorWall, u: number): void {
  const w = wall.depth * 0.5;
  wall.bins.add('body', faceBox(wall.face, u - 0.18, 0, w - 0.18, u + 0.18, 0.36, w + 0.18), 0x8a5a3a);
  const [x, , z] = faceToWorld(wall.face, u, 0, w);
  wall.bins.add('body', sphereGeometry(x, 0.58, z, 0.2, { widthSegments: 6, heightSegments: 4, scaleY: 1.2 }), PALETTE.hedgeLight);
  wall.bins.add('body', sphereGeometry(x + 0.06, 0.78, z - 0.04, 0.13, { widthSegments: 6, heightSegments: 4 }), PALETTE.hedge);
}

/** Teal trading floor: glowing grid, candlestick screens and a scrolling ticker. */
function exchangeDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomMap, res: ResourceBag, animators: Animator[]): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  const screens: Array<[number, number, number, number]> = [
    [anchor - 2.2, anchor + 2.2, 0.95, 2.0],
    [anchor - 10.6, anchor - 7.4, 1.1, 1.95],
    [anchor - 6.8, anchor - 3.4, 1.1, 1.95],
  ];
  screens.forEach(([u0, u1, v0, v1], index) => {
    if (!inSpans(north, u0 - 0.06, u1 + 0.06)) return;
    north.bins.add('body', faceBox(nf, u0 - 0.06, v0 - 0.06, 0, u1 + 0.06, v1 + 0.06, 0.07), 0x0c1216);
    north.bins.add('unlit', faceBox(nf, u0, v0, 0.07, u1, v1, 0.075), 0x06141b);
    candlesticks(north, u0 + 0.1, u1 - 0.1, v0 + 0.1, v1 - 0.12, index);
  });
  // LED ticker along the top of the north wall.
  const [a, b] = north.spans[0] ?? [INTERIOR_WALL_THICKNESS, map.width - INTERIOR_WALL_THICKNESS];
  const tickerWidth = b - a;
  const tickerHeight = 0.14;
  const strip = createTickerStrip(EXCHANGE_TICKER);
  const texture = res.texture(strip.texture);
  texture.repeat.set(tickerWidth / (tickerHeight / strip.height) / strip.width, 1);
  const material = res.material(new MeshBasicMaterial({ map: texture, toneMapped: false }));
  const ticker = new Mesh(res.geometry(new PlaneGeometry(tickerWidth, tickerHeight)), material);
  ticker.name = `${north.group.name}:ticker`;
  const [tx, ty, tz] = faceToWorld(nf, (a + b) / 2, 2.07, 0.012);
  ticker.position.set(tx, ty, tz);
  north.group.add(ticker);
  north.fadeMaterials.push(material);
  north.bins.add('body', faceBox(nf, a, 1.98, 0, b, 2.16, 0.01), 0x0b1215);
  animators.push((elapsed) => {
    texture.offset.x = (((elapsed / 1000) * 12) / strip.width) % 1;
  });

  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [s0, s1] of wall.spans) {
      for (let u = s0 + 0.8; u < s1 - 0.4; u += 2.4) {
        wall.bins.add('unlit', faceBox(wall.face, u - 0.02, 0.2, 0.02, u + 0.02, 2.0, 0.04), theme.floorAccent);
      }
      const mid = (s0 + s1) / 2;
      for (const u of [mid - 1.4, mid + 1.4]) {
        wall.bins.add('body', faceBox(wall.face, u - 0.62, 1.05, 0, u + 0.62, 1.8, 0.06), 0x0c1216);
        wall.bins.add('unlit', faceBox(wall.face, u - 0.56, 1.1, 0.06, u + 0.56, 1.75, 0.065), 0x06141b);
        for (let i = 0; i < 6; i++) {
          const h = 0.1 + hash01(Math.round(u * 10), i, 321) * 0.45;
          const bu = u - 0.48 + i * 0.17;
          wall.bins.add('unlit', faceBox(wall.face, bu, 1.15, 0.065, bu + 0.11, 1.15 + h, 0.07), i % 2 === 0 ? 0x3fd1c1 : 0xffc861);
        }
      }
      pottedPlant(wall, s1 - 0.6);
    }
  }
  // A faint glowing grid across the walkable floor.
  const glowLine = mixColor(theme.floorA, theme.floorAccent, 0.22);
  for (let x = 2; x < map.width - 1; x++) shell.floor.add('glow', flatQuad(x - 0.015, 1, x + 0.015, map.height - 1, 0.004), glowLine);
  for (let y = 2; y < map.height - 1; y++) shell.floor.add('glow', flatQuad(1, y - 0.015, map.width - 1, y + 0.015, 0.004), glowLine);
}

function candlesticks(wall: InteriorWall, u0: number, u1: number, v0: number, v1: number, seed: number): void {
  const count = Math.max(6, Math.round((u1 - u0) / 0.28));
  const step = (u1 - u0) / count;
  let level = 0.5;
  const points: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const move = (hash01(seed, i, 331) - 0.45) * 0.3;
    const open = level;
    const close = clamp01(level + move);
    level = close;
    const lo = Math.min(open, close);
    const hi = Math.max(open, close);
    const u = u0 + step * (i + 0.5);
    const y = (value: number) => v0 + (v1 - v0) * (0.12 + value * 0.76);
    const colour = close >= open ? 0x3fe08a : 0xff5d5d;
    wall.bins.add('unlit', faceBox(wall.face, u - step * 0.3, y(lo), 0.075, u + step * 0.3, Math.max(y(hi), y(lo) + 0.02), 0.08), colour);
    wall.bins.add('unlit', faceBox(wall.face, u - 0.008, y(Math.max(0, lo - 0.06)), 0.075, u + 0.008, y(Math.min(1, hi + 0.06)), 0.078), colour);
    points.push([u, y(close) + 0.06]);
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const [ua, va] = points[i]!;
    const [ub, vb] = points[i + 1]!;
    wall.bins.add('unlit', beamGeometry(faceToWorld(wall.face, ua, va, 0.085), faceToWorld(wall.face, ub, vb, 0.085), 0.008, 0.018), 0x7cf2e0);
  }
}

/** Cream and blue, a pigeonhole cabinet, a clock and shelves of parcels. */
function postOfficeDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomMap): void {
  const north = shell.walls.north;
  const nf = north.face;
  const centre = map.width / 2;
  const [c0, c1, v0, v1] = [centre - 3, centre + 3, 0.15, 1.95];
  if (inSpans(north, c0, c1)) {
    const depth = 0.32;
    north.bins.add('body', faceBox(nf, c0, v0, 0, c1, v1, depth), 0x8a5a3a);
    const cols = 10;
    const rows = 5;
    const cw = (c1 - c0 - 0.12) / cols;
    const ch = (v1 - v0 - 0.12) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u = c0 + 0.06 + c * cw;
        const v = v0 + 0.06 + r * ch;
        north.bins.add('body', faceBox(nf, u + 0.03, v + 0.03, depth, u + cw - 0.03, v + ch - 0.03, depth + 0.004), 0x3a2a20);
        const roll = hash01(r, c, 341);
        if (roll < 0.55) {
          const colour = pick([0xf6efe0, 0xf4c7d0, 0xc9dcf2, 0xf2e2b0], hash01(r, c, 342));
          north.bins.add('body', faceBox(nf, u + 0.08, v + 0.05, depth + 0.004, u + cw - 0.08, v + 0.05 + ch * 0.45, depth + 0.02), colour);
        }
      }
    }
  }
  const clockU = centre - 5.6;
  if (inSpans(north, clockU - 0.35, clockU + 0.35)) {
    north.bins.add('body', faceDisc(nf, clockU, 1.55, 0, 0.3, 0.05, 16), 0xf6efe0);
    north.bins.add('body', faceTorus(nf, clockU, 1.55, 0.04, 0.3, 0.03, { tubularSegments: 16 }), theme.floorAccent);
    north.bins.add('body', faceBox(nf, clockU - 0.01, 1.55, 0.05, clockU + 0.01, 1.76, 0.06), 0x2b2b30);
    north.bins.add('body', faceBox(nf, clockU, 1.54, 0.05, clockU + 0.15, 1.56, 0.06), 0x2b2b30);
  }
  const posterU = centre + 5.8;
  if (inSpans(north, posterU - 0.5, posterU + 0.5)) {
    north.bins.add('body', faceBox(nf, posterU - 0.45, 1.0, 0, posterU + 0.45, 1.75, 0.02), 0xf6efe0);
    for (let i = 0; i < 9; i++) {
      const u = posterU - 0.45 + i * 0.1;
      const colour = i % 2 === 0 ? theme.floorAccent : theme.trim;
      north.bins.add('body', faceBox(nf, u, 1.7, 0.02, u + 0.1, 1.75, 0.025), colour);
      north.bins.add('body', faceBox(nf, u, 1.0, 0.02, u + 0.1, 1.05, 0.025), colour);
    }
    north.bins.add('body', faceBox(nf, posterU - 0.25, 1.25, 0.02, posterU + 0.25, 1.5, 0.025), theme.floorAccent);
  }
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [s0, s1] of wall.spans) {
      const a = s0 + 1.2;
      const b = s1 - 0.8;
      if (b - a < 1) continue;
      for (const v of [0.85, 1.5]) {
        wall.bins.add('body', faceBox(wall.face, a, v, 0, b, v + 0.04, 0.4), 0x8a5a3a);
        let u = a + 0.08;
        let i = 0;
        while (u < b - 0.25) {
          const seed = hash01(Math.round(u * 10), Math.round(v * 10), 351 + i);
          const w = 0.22 + seed * 0.2;
          const h = 0.16 + hash01(i, Math.round(v * 10), 352) * 0.2;
          const d = 0.2 + hash01(i, Math.round(u * 10), 353) * 0.16;
          if (u + w > b - 0.05) break;
          wall.bins.add('body', faceBox(wall.face, u, v + 0.04, 0.02, u + w, v + 0.04 + h, 0.02 + d), jitterColor(0xc49a6c, seed, 0.06));
          wall.bins.add('body', faceBox(wall.face, u + w * 0.42, v + 0.04 + h, 0.02, u + w * 0.58, v + 0.045 + h, 0.02 + d), 0xe8d8b0);
          u += w + 0.06;
          i++;
        }
      }
    }
  }
  perimeterInlay(shell, map, 0.3, 0.14, theme.floorAccent);
}

/** Riveted steel, pipes, hazard stripes and the chain portal behind the deposit desk. */
function bridgeDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomMap, res: ResourceBag, animators: Animator[]): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  const py = 1.15;
  const steel = 0x8795a3;
  if (inSpans(north, anchor - 1.3, anchor + 1.3)) {
    north.bins.add('body', faceTorus(nf, anchor, py, 0.2, 0.85, 0.12, { radialSegments: 6, tubularSegments: 22 }), steel);
    for (const side of [-1, 1]) {
      const u = anchor + side * 1.1;
      north.bins.add('body', faceBox(nf, u - 0.15, 0, 0, u + 0.15, 2.15, 0.36), 0x3e4c5a);
      for (const v of [0.6, 1.2, 1.8]) {
        north.bins.add('unlit', faceBox(nf, u - 0.06, v, 0.36, u + 0.06, v + 0.08, 0.37), theme.trim);
      }
    }
    // The portal's swirling face: its own mesh so it can turn.
    const geometry = res.geometry(new RingGeometry(0, 0.76, 32, 4));
    const position = geometry.getAttribute('position');
    const colours = new Float32Array(position.count * 3);
    const deep = new Color(0x1b3a6b);
    const bright = new Color(0x7ad8ff);
    const warm = new Color(0xffc877);
    const scratch = new Color();
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const r = Math.hypot(x, y) / 0.76;
      const angle = Math.atan2(y, x);
      const swirl = 0.5 + 0.5 * Math.sin(angle * 3 + r * 7);
      scratch.copy(deep).lerp(bright, swirl * (1 - r * 0.4)).lerp(warm, Math.max(0, 0.6 - r) * 0.5);
      colours[i * 3] = scratch.r;
      colours[i * 3 + 1] = scratch.g;
      colours[i * 3 + 2] = scratch.b;
    }
    geometry.setAttribute('color', new BufferAttribute(colours, 3));
    const material = res.material(unlitMaterial());
    const disc = new Mesh(geometry, material);
    disc.name = `${north.group.name}:portal`;
    const [x, y, z] = faceToWorld(nf, anchor, py, 0.18);
    disc.position.set(x, y, z);
    north.group.add(disc);
    north.fadeMaterials.push(material);
    animators.push((elapsed) => {
      disc.rotation.z = -(elapsed / 1000) * 0.9;
    });
  }
  for (const [a, b] of north.spans) {
    for (const [s0, s1] of [
      [a, Math.min(b, anchor - 1.4)],
      [Math.max(a, anchor + 1.4), b],
    ] as const) {
      if (s1 - s0 < 0.3) continue;
      north.bins.add('body', facePipe(nf, s0, s1, 1.96, 0.12, 0.06), 0x6d7b89);
      north.bins.add('body', facePipe(nf, s0, s1, 0.32, 0.1, 0.045), 0x9a6b3c);
    }
  }
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [s0, s1] of wall.spans) {
      wall.bins.add('body', facePipe(wall.face, s0, s1, 1.9, 0.12, 0.06), 0x6d7b89);
      wall.bins.add('body', facePipe(wall.face, s0, s1, 0.38, 0.1, 0.045), 0x9a6b3c);
      for (let u = s0 + 1; u + 0.8 < s1; u += 2.2) {
        wall.bins.add('body', faceBox(wall.face, u - 0.7, 0.55, 0, u + 0.7, 1.7, 0.03), theme.wallLower);
        for (const [du, v] of [
          [-0.62, 0.63],
          [0.62, 0.63],
          [-0.62, 1.62],
          [0.62, 1.62],
        ] as const) {
          wall.bins.add('body', faceBox(wall.face, u + du - 0.03, v - 0.03, 0.03, u + du + 0.03, v + 0.03, 0.05), 0x9aa6b2);
        }
        wall.bins.add('unlit', faceBox(wall.face, u - 0.08, 1.2, 0.03, u + 0.08, 1.28, 0.04), theme.trim);
      }
    }
  }
  // Hazard band inside the walls: amber and charcoal squares.
  const y = 0.006;
  const band = (x0: number, z0: number, x1: number, z1: number) => {
    const alongX = x1 - x0 > z1 - z0;
    const length = alongX ? x1 - x0 : z1 - z0;
    const count = Math.floor(length / 0.25);
    for (let i = 0; i < count; i++) {
      const colour = i % 2 === 0 ? theme.floorAccent : 0x2a2f36;
      if (alongX) shell.floor.add('floor', flatQuad(x0 + i * 0.25, z0, x0 + (i + 1) * 0.25, z1, y), colour);
      else shell.floor.add('floor', flatQuad(x0, z0 + i * 0.25, x1, z0 + (i + 1) * 0.25, y), colour);
    }
  };
  const inset = 0.12;
  const w = 0.16;
  band(1 + inset, 1 + inset, map.width - 1 - inset, 1 + inset + w);
  band(1 + inset, 1 + inset + w, 1 + inset + w, map.height - 1 - inset);
  band(map.width - 1 - inset - w, 1 + inset + w, map.width - 1 - inset, map.height - 1 - inset);
}
