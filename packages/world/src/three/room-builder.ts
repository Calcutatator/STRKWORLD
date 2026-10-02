import {
  BufferAttribute,
  CircleGeometry,
  Color,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
} from 'three';
import type { BufferGeometry, Material, MeshStandardMaterial, Object3D, Texture } from 'three';
import type { StationId } from '@strkworld/shared';
import {
  isFixedRoomSolidAt,
  type FixedRoomLevelMap,
  type FixedRoomRect,
  type FixedRoomStationDefinition,
  type FixedRoomStationPresentation,
} from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { PIXELS_PER_UNIT } from './coords.js';
import {
  DEGEN,
  DEGEN_ROOM_TICKER,
  DEGEN_TOKENS,
  EXCHANGE_ROOM_TICKER,
  GeometryBin,
  PALETTE,
  ResourceBag,
  STRK20,
  AVNU,
  AVNU_COUNTER_HEADER,
  DEGEN_COUNTER_HEADER,
  ENDUR,
  NEAR,
  NEAR_DEPARTURE_HEADER,
  POST_OFFICE_SEND_SIGN,
  POST_OFFICE_SEND_TEXT,
  POST_OFFICE_WINDOW_SIGN,
  VESU,
  VESU_MARK,
  addVesuMark,
  aoPaint,
  beamGeometry,
  boxGeometry,
  clamp01,
  coneGeometry,
  createOpacityFader,
  createTickerStrip,
  css,
  cylinderGeometry,
  faceBox,
  faceDisc,
  facePanel,
  faceQuad,
  faceToWorld,
  faceTorus,
  flatPolygon,
  flatQuad,
  flushBin,
  hash01,
  jitterColor,
  lift,
  liftGoesUp,
  liftLabelText,
  mixColor,
  mixHex,
  pick,
  prismX,
  prismZ,
  roomTheme,
  runsWhere,
  shade,
  sphereGeometry,
  standardMaterial,
  stationTheme,
  unlitMaterial,
  vesuMarkColour,
  type DegenMotif,
  type DegenToken,
  type Face,
  type Paint,
  type RoomTheme,
  type StationLook,
  type StationLooks,
  type StationPropStyle,
  type StationTheme,
  type TickerSegment,
} from './palette.js';
import type { FloatingStyleOptions, SignStyleOptions } from './labels.js';
import type { ImageTextureLoader, LabelFactory, Occluder, OccluderBounds, RoomView, TextLabel } from './types.js';

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

/** The Degen floor's neon sign, behind its counter. */
export const DEGEN_SIGN_TEXT = 'DEGEN\nMODE';

/**
 * Where the Degen floor hangs its posters, in the order `DEGEN_TOKENS` fills
 * them: the north wall first (the camera faces it), then the side walls. Each
 * `u` is a poster's centre along its wall. The north wall keeps the sign
 * behind the counter and the lift doors clear.
 */
export const DEGEN_POSTER_SLOTS: readonly { readonly wall: InteriorWallSide; readonly u: number }[] = Object.freeze([
  { wall: 'north', u: 2.2 },
  { wall: 'north', u: 4.15 },
  { wall: 'north', u: 6.1 },
  { wall: 'north', u: 12.2 },
  { wall: 'west', u: 5.2 },
  { wall: 'east', u: 5.2 },
  { wall: 'west', u: 7.7 },
  { wall: 'east', u: 7.7 },
]);

/**
 * A Degen-floor poster in world units: the 2:3 portrait of its 512 by 768
 * art, pasted over the chair rail, from above the floor's neon strip to just
 * under the LED run.
 */
export const DEGEN_POSTER_SIZE = Object.freeze({ width: 1.04, height: 1.56 });
export const DEGEN_POSTER_BOTTOM = 0.33;
/** How far the art stands out of the wall: in front of every stand-in part, inside the frame's lip. */
export const DEGEN_POSTER_DEPTH = 0.075;
const DEGEN_POSTER_FRAME = 0.045;

const DEGEN_SIGN_STYLE: SignStyleOptions = Object.freeze({
  width: 3.2,
  height: 0.62,
  background: '#11131d',
  foreground: '#ff3dbb',
  accent: '#ff3dbb',
  subtitleColor: '#b8ff3d',
  cornerRadius: 0.22,
  borderWidth: 0.05,
  hairline: false,
  titleFont: 'display',
  titleWeight: 900,
  titleTracking: 0.14,
  subtitleFont: 'mono',
  subtitleWeight: 700,
  subtitleTracking: 0.6,
  uppercase: true,
});

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
  // And a dark backdrop behind the north wall: the fixed camera looks nearly
  // level (camera-rig.ts), so without it the view over the wall ends in sky.
  floor.add('apron', faceQuad({ normal: 'z+', plane: -1.5 }, -30, -0.02, W + 30, 14, 0), APRON_COLOUR);

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
  readonly looks: StationLooks;
  labelText: string;
  look: StationLook;
  highlighted: boolean;
}

/**
 * `images` decodes the room's bundled art (the Degen floor's posters). Without
 * one — node tests, or a host that cannot decode — every poster stays its
 * procedural stand-in, which is also what shows while art loads or if it fails.
 */
export function buildFixedRoom(
  map: FixedRoomLevelMap,
  labels: LabelFactory,
  origin: { readonly x: number; readonly y: number } = ROOM_ORIGIN,
  images: ImageTextureLoader | null = null,
): RoomView {
  const res = new ResourceBag();
  const theme = roomTheme(map.building, map.level);
  // Copy the origin now: a caller mutating its object later must not move the room.
  const ox = origin.x / PIXELS_PER_UNIT;
  const oz = origin.y / PIXELS_PER_UNIT;
  const group = new Group();
  // A ground floor keeps its building's name; a floor reached by lift adds its own.
  group.name = map.level === 'ground' ? `room:${map.building}` : `room:${map.building}:${map.level}`;
  group.userData['building'] = map.building;
  group.userData['level'] = map.level;
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
    decorateRoom(theme, shell, map, res, animators, labels, textLabels, images);
    fixtureProps(map, theme, shell);
    exitDecor(map, theme, shell);
    liftDecor(map, theme, shell, labels, textLabels, group);
    for (const station of map.stations) {
      const counter = BUILT_IN_COUNTERS[station.station];
      stations.push(
        counter
          ? buildBuiltInStation(station, counter, map, theme, shell, labels, res, group, textLabels)
          : buildStation(station, theme, labels, res, group, textLabels),
      );
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
  const looks = view.looks;
  const look = available
    ? highlighted
      ? looks.highlighted
      : looks.available
    : highlighted
      ? looks.lockedHighlighted
      : looks.locked;
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

/**
 * A counter on the station rect, a status beacon, a floating label and the
 * approach halo, dressed in the station's own theme or else its room's.
 */
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
  const dress = stationTheme(theme, station.station);

  const accent = res.material(standardMaterial({ vertexColors: false, roughness: 0.5 }));
  const haloFill = res.material(unlitMaterial({ vertexColors: false, transparent: true }));
  const haloEdge = res.material(unlitMaterial({ vertexColors: false, transparent: true }));
  const bin = new GeometryBin();
  try {
    bin.add('body', boxGeometry(x0, 0, z0, x1, 0.92, z1), aoPaint(dress.kioskBase, 0.1));
    bin.add('body', boxGeometry(x0 - 0.05, 0.92, z0 - 0.05, x1 + 0.05, 1, z1 + 0.05), dress.kioskTop);
    bin.add('body', boxGeometry(x0 + 0.03, 0, z1, x1 - 0.03, 0.1, z1 + 0.02), dress.kioskTrim ?? shade(dress.kioskBase, -0.12));
    bin.add('accent', boxGeometry(x0 + 0.12, 0.3, z1, x1 - 0.12, 0.72, z1 + 0.03), 0xffffff);
    stationProps(dress.props, theme, bin, x0, x1, z0, z1);

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

  // A typed value, not an inline literal: the style fields ride along to
  // factories that understand them and are ignored by any that do not.
  const labelStyle: FloatingStyleOptions = { lineHeight: 0.3, ...dress.label };
  const label = labels.floating(station.label, labelStyle);
  textLabels.push(label);
  label.object.position.set(cx, STATION_LABEL_Y, cz);
  label.object.userData['station'] = station.station;
  group.add(label.object);
  // A branded counter names its protocol on the status panel, whose state
  // colour frames the plate; the Shell's label above it is untouched.
  if (dress.plate) {
    const plate = labels.sign(dress.plate.text, dress.plate.style);
    textLabels.push(plate);
    plate.object.position.set(cx, 0.51, z1 + 0.036);
    plate.object.userData['brand'] = station.station;
    group.add(plate.object);
  }

  const view: StationView = {
    station: station.station,
    group,
    accent,
    haloFill,
    haloEdge,
    beacon,
    label,
    phase: hash01(Math.round(cx * 10), Math.round(cz * 10), 301) * Math.PI * 2,
    looks: dress.looks,
    labelText: station.label,
    look: dress.looks.locked,
    highlighted: false,
  };
  // Until the Shell reports otherwise a station is locked (fixed-room.ts).
  applyStation(view, { ...station, status: 'locked', highlighted: false });
  return view;
}

// ---------------------------------------------------------------------------
// Built-in counters
// ---------------------------------------------------------------------------

/** Where a built-in counter paints the Shell's label: a sign on its own architecture. */
interface CounterHeader {
  readonly position: readonly [number, number, number];
  readonly style: SignStyleOptions;
}

interface CounterContext {
  readonly station: FixedRoomStationDefinition;
  readonly map: FixedRoomLevelMap;
  readonly theme: RoomTheme;
  readonly dress: StationTheme;
  /** Keys: 'body' (lit, vertex coloured), 'unlit' (self-lit) and 'accent' (the station's state colour). */
  readonly bin: GeometryBin;
  readonly shell: InteriorShell;
  readonly group: Group;
  readonly labels: LabelFactory;
  readonly textLabels: TextLabel[];
}

type CounterBuilder = (ctx: CounterContext) => CounterHeader;

/**
 * Counters built into their room instead of standing on the floor: each
 * dresses its station rect and the `fixtures` its floor authors round it
 * (fixed-room.ts), and paints the Shell's label on a sign of its own
 * architecture. The station ids, rects and approach are unchanged.
 */
const BUILT_IN_COUNTERS: Readonly<Partial<Record<StationId, CounterBuilder>>> = Object.freeze({
  'exchange:swap': tradingDesk,
  'exchange:degen': degenBar,
  'post-office:transfer': postOfficeCounter,
  'bridge:deposit': gatewayTerminal,
});

/** The stations whose counters are built into their rooms. */
export const BUILT_IN_COUNTER_STATIONS: readonly StationId[] = Object.freeze(Object.keys(BUILT_IN_COUNTERS) as StationId[]);

/**
 * A built-in counter: the room's furniture round the station, its status
 * lights, the beacon, the halo on the approach tiles a player can stand on,
 * and the Shell's label on the counter's own sign.
 */
function buildBuiltInStation(
  station: FixedRoomStationDefinition,
  build: CounterBuilder,
  map: FixedRoomLevelMap,
  theme: RoomTheme,
  shell: InteriorShell,
  labels: LabelFactory,
  res: ResourceBag,
  parent: Group,
  textLabels: TextLabel[],
): StationView {
  const group = new Group();
  group.name = `station:${station.station}`;
  group.userData['station'] = station.station;
  parent.add(group);
  const dress = stationTheme(theme, station.station);
  const accent = res.material(standardMaterial({ vertexColors: false, roughness: 0.5 }));
  const haloFill = res.material(unlitMaterial({ vertexColors: false, transparent: true }));
  const haloEdge = res.material(unlitMaterial({ vertexColors: false, transparent: true }));
  const bin = new GeometryBin();
  let header: CounterHeader;
  try {
    header = build({ station, map, theme, dress, bin, shell, group, labels, textLabels });
    approachHalo(bin, station, map);
    flushBin(bin, 'body', res.material(standardMaterial({ roughness: 0.7 })), res, group, {
      name: `${group.name}:counter`,
      cast: true,
      receive: true,
    });
    if (bin.has('unlit')) flushBin(bin, 'unlit', res.material(unlitMaterial()), res, group, { name: `${group.name}:screen` });
    flushBin(bin, 'accent', accent, res, group, { name: `${group.name}:status` });
    flushBin(bin, 'fill', haloFill, res, group, { name: `${group.name}:halo`, renderOrder: 1 });
    flushBin(bin, 'edge', haloEdge, res, group, { name: `${group.name}:halo-edge`, renderOrder: 1 });
  } finally {
    bin.dispose();
  }
  const cx = station.x + station.width / 2;
  const cz = station.y + station.height / 2;
  const beacon = new Mesh(res.geometry(new OctahedronGeometry(0.14, 0)), accent);
  beacon.name = `${group.name}:beacon`;
  beacon.position.set(cx, STATION_BEACON_Y, cz);
  group.add(beacon);

  const label = labels.sign(station.label, header.style);
  textLabels.push(label);
  label.object.position.set(...header.position);
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
    looks: dress.looks,
    labelText: station.label,
    look: dress.looks.locked,
    highlighted: false,
  };
  applyStation(view, { ...station, status: 'locked', highlighted: false });
  return view;
}

/**
 * The approach halo, laid only on the approach tiles a player can stand on:
 * a built-in counter's furniture fills the rest of its ring. Each tile is
 * inset and edged only where the region ends, so the pad reads as one.
 */
function approachHalo(bin: GeometryBin, station: FixedRoomStationDefinition, map: FixedRoomLevelMap): void {
  const onPad = (x: number, y: number): boolean =>
    x >= station.x - 1 &&
    x < station.x + station.width + 1 &&
    y >= station.y - 1 &&
    y < station.y + station.height + 1 &&
    !isFixedRoomSolidAt(map, x, y);
  const inset = 0.04;
  const e = 0.06;
  for (let y = station.y - 1; y < station.y + station.height + 1; y++) {
    for (let x = station.x - 1; x < station.x + station.width + 1; x++) {
      if (!onPad(x, y)) continue;
      const [west, east, north, south] = [!onPad(x - 1, y), !onPad(x + 1, y), !onPad(x, y - 1), !onPad(x, y + 1)];
      const x0 = x + (west ? inset : 0);
      const x1 = x + 1 - (east ? inset : 0);
      const z0 = y + (north ? inset : 0);
      const z1 = y + 1 - (south ? inset : 0);
      bin.add('fill', flatQuad(x0, z0, x1, z1, 0.012), 0xffffff);
      if (north) bin.add('edge', flatQuad(x0, z0, x1, z0 + e, 0.015), 0xffffff);
      if (south) bin.add('edge', flatQuad(x0, z1 - e, x1, z1, 0.015), 0xffffff);
      if (west) bin.add('edge', flatQuad(x0, z0 + (north ? e : 0), x0 + e, z1 - (south ? e : 0), 0.015), 0xffffff);
      if (east) bin.add('edge', flatQuad(x1 - e, z0 + (north ? e : 0), x1, z1 - (south ? e : 0), 0.015), 0xffffff);
    }
  }
}

/** A screen on a face: a bezel and a self-lit card, rounded as avnu's cards are. */
function avnuScreen(bin: GeometryBin, face: Face, u0: number, v0: number, u1: number, v1: number): void {
  bin.add('unlit', facePanel(face, u0 - 0.03, v0 - 0.03, u1 + 0.03, v1 + 0.03, 0.006, 0.08), AVNU.indigoBorder);
  bin.add('unlit', facePanel(face, u0, v0, u1, v1, 0.012, 0.06), AVNU.card);
}

/** Quote rows on a screen: a token dot, a name bar and a level bar per row. Bars only: nothing live. */
function quoteRows(bin: GeometryBin, face: Face, u0: number, v0: number, u1: number, v1: number, seed: number): void {
  const rows = 3;
  const step = (v1 - v0) / rows;
  const dots = [AVNU.lightBlue, AVNU.blue, AVNU.slate, DEGEN.cyan];
  for (let i = 0; i < rows; i++) {
    const mid = v1 - step * (i + 0.5);
    bin.add('unlit', faceDisc(face, u0 + 0.12, mid, 0.012, 0.045, 0.006, 10), dots[(i + seed) % dots.length]!);
    bin.add('unlit', facePanel(face, u0 + 0.24, mid - 0.022, u0 + 0.24 + 0.3 + 0.2 * hash01(seed, i, 611), mid + 0.022, 0.018, 0.02), AVNU.slate);
    const length = 0.22 + 0.36 * hash01(seed, i, 612);
    bin.add('unlit', facePanel(face, u1 - 0.1 - length, mid - 0.028, u1 - 0.1, mid + 0.028, 0.018, 0.028), i % 2 === 0 ? AVNU.blue : AVNU.lightBlue);
  }
}

/**
 * avnu's trading desk (the Exchange's SWAP): a long navy desk across the
 * room's north-east corner on a raised pit, the counter its middle bay, and
 * behind it a wall of boards standing in front of the north wall, three
 * columns of screens: candlestick charts and avnu's swap card above, quote
 * rows below, all bars and lines, nothing live. Low monitors face the floor
 * from the desk's wings, and a gantry over the bay carries the label on a
 * navy pill, its posts lit in the station's state. The room's ticker runs
 * along the north wall just above the boards.
 */
function tradingDesk(ctx: CounterContext): CounterHeader {
  const { station: s, bin, theme } = ctx;
  const bx0 = s.x;
  const bx1 = s.x + s.width;
  const x0 = s.x - 2 + 0.06;
  const x1 = s.x + s.width + 2 - 0.02;
  const z0 = s.y + 0.1;
  const z1 = s.y + s.height - 0.04;
  const top = 1;
  // The pit: a low plinth the desk and the boards stand on.
  bin.add('body', boxGeometry(x0 - 0.04, 0, s.y - 2, x1, 0.06, z1 + 0.02), lift(AVNU.card, 0.03));
  bin.add('unlit', boxGeometry(x0 - 0.04, 0.03, z1 + 0.02, x1, 0.06, z1 + 0.035), AVNU.indigoBorder);

  // The wall of boards, in front of the north wall.
  const [q0, q1, qTop] = [INTERIOR_WALL_THICKNESS + 0.06, s.y - 2 + 0.46, 1.98];
  bin.add('body', boxGeometry(x0 - 0.04, 0.06, q0, x1, qTop, q1), aoPaint(AVNU.navy, 0.08));
  bin.add('body', boxGeometry(x0 - 0.06, qTop, q0, x1, qTop + 0.05, q1 + 0.03), AVNU.indigoBorder);
  const qf: Face = { normal: 'z+', plane: q1 };
  const columns: ReadonlyArray<readonly [number, number]> = [
    [x0 + 0.12, bx0 - 0.1],
    [bx0 + 0.06, bx1 - 0.06],
    [bx1 + 0.1, x1 - 0.12],
  ];
  const [r0, r1] = [[0.52, 1.1], [1.2, 1.88]] as const;
  columns.forEach(([u0, u1], index) => {
    avnuScreen(bin, qf, u0, r1[0], u1, r1[1]);
    if (index === 1) {
      // avnu's swap card: two token fields and the primary pill.
      const fields: ReadonlyArray<readonly [number, number, number]> = [
        [1.62, 1.8, AVNU.lightBlue],
        [1.4, 1.58, AVNU.slate],
      ];
      for (const [v0, v1, token] of fields) {
        const mid = (v0 + v1) / 2;
        bin.add('unlit', facePanel(qf, u0 + 0.12, v0, u1 - 0.12, v1, 0.02, 0.09), AVNU.navy);
        bin.add('unlit', faceDisc(qf, u0 + 0.26, mid, 0.022, 0.05, 0.006, 10), token);
        bin.add('unlit', facePanel(qf, u1 - 0.7, mid - 0.02, u1 - 0.24, mid + 0.02, 0.026, 0.02), AVNU.slate);
      }
      bin.add('unlit', facePanel(qf, u0 + 0.12, 1.25, u1 - 0.12, 1.35, 0.02, 0.05), AVNU.blue);
    } else {
      candlesticks(bin, qf, u0 + 0.1, u1 - 0.1, r1[0] + 0.02, r1[1] - 0.04, index + 3, { up: AVNU.lightBlue, down: AVNU.slate, line: AVNU.blue });
    }
    avnuScreen(bin, qf, u0, r0[0], u1, r0[1]);
    quoteRows(bin, qf, u0 + 0.02, r0[0] + 0.04, u1, r0[1] - 0.04, index);
  });

  // The desk: navy, a blue light line under its top, pill panels on the wings.
  bin.add('body', boxGeometry(x0, 0.06, z0, x1, 0.9, z1), aoPaint(AVNU.card, 0.1));
  bin.add('body', boxGeometry(x0 - 0.03, 0.9, z0 - 0.03, x1, top, z1 + 0.03), lift(AVNU.navy, 0.05));
  bin.add('body', boxGeometry(bx0, top, z0 + 0.06, bx1, top + 0.012, z1 + 0.03), lift(AVNU.indigoBorder, 0.06));
  bin.add('body', boxGeometry(x0 + 0.02, 0.06, z1, x1 - 0.02, 0.16, z1 + 0.015), AVNU.navy);
  bin.add('unlit', boxGeometry(x0, 0.84, z1, x1, 0.87, z1 + 0.02), AVNU.blue);
  const front: Face = { normal: 'z+', plane: z1 };
  for (const [a, b] of [[x0, bx0], [bx1, x1]] as const) {
    const mid = (a + b) / 2;
    for (const u of [mid - 0.46, mid + 0.46]) {
      bin.add('unlit', facePanel(front, u - 0.38, 0.32, u + 0.38, 0.66, 0.012, 0.17), AVNU.indigo);
      bin.add('unlit', facePanel(front, u - 0.28, 0.45, u + 0.1, 0.53, 0.016, 0.04), AVNU.indigoBorder);
    }
    // Low monitors facing the floor, a mini chart each.
    for (const u of [mid - 0.48, mid + 0.48]) {
      const mz = s.y + 0.42;
      const mf: Face = { normal: 'z+', plane: mz + 0.05 };
      bin.add('body', boxGeometry(u - 0.04, top, mz - 0.06, u + 0.04, top + 0.12, mz), AVNU.navy);
      bin.add('body', boxGeometry(u - 0.36, top + 0.1, mz, u + 0.36, top + 0.46, mz + 0.05), AVNU.navy);
      bin.add('unlit', facePanel(mf, u - 0.32, top + 0.13, u + 0.32, top + 0.43, 0.004, 0.03), AVNU.card);
      for (let i = 0; i < 5; i++) {
        const h = 0.05 + 0.18 * hash01(Math.round(u * 10), i, 621);
        const bu = u - 0.24 + i * 0.11;
        bin.add('unlit', faceBox(mf, bu, top + 0.17, 0.006, bu + 0.06, top + 0.17 + h, 0.01), i % 2 === 0 ? AVNU.blue : AVNU.lightBlue);
      }
    }
  }
  // The counter: the status panel in the bay, avnu's swap card on the desk.
  bin.add('accent', boxGeometry(bx0 + 0.14, 0.28, z1, bx1 - 0.14, 0.72, z1 + 0.03), 0xffffff);
  stationProps('avnu', theme, bin, bx0 + 0.1, bx1 - 0.1, s.y + 0.14, s.y + s.height - 0.1);

  // The gantry over the bay: two posts, lit in the state colour, and a crossbar.
  const gz = s.y + 0.5;
  for (const u of [bx0, bx1]) {
    bin.add('body', boxGeometry(u - 0.05, top, gz - 0.05, u + 0.05, 2.1, gz + 0.05), AVNU.navy);
    bin.add('accent', boxGeometry(u - 0.022, top + 0.04, gz + 0.05, u + 0.022, 1.68, gz + 0.062), 0xffffff);
  }
  bin.add('body', boxGeometry(bx0 - 0.08, 1.7, gz - 0.07, bx1 + 0.08, 2.12, gz + 0.07), AVNU.navy);
  bin.add('unlit', boxGeometry(bx0 - 0.08, 2.12, gz - 0.07, bx1 + 0.08, 2.135, gz + 0.07), AVNU.blue);
  return { position: [(bx0 + bx1) / 2, 1.91, gz + 0.076], style: AVNU_COUNTER_HEADER };
}

/**
 * The Degen floor's back room (DEGEN SWAP): a booth set into the poster wall
 * between the posters, its partitions edged in pink and violet neon and
 * pink light pooled on its floor, the DEGEN MODE sign on its back wall over
 * a back bar of neon chip stacks, and a black bar across its mouth with a
 * cyan edge and pink underglow, the counter its middle. The label is a neon
 * tube sign on the lintel, underlined in the station's state colour.
 */
function degenBar(ctx: CounterContext): CounterHeader {
  const { station: s, bin, theme } = ctx;
  const left = s.x - 1;
  const right = s.x + s.width + 1;
  const back = INTERIOR_WALL_THICKNESS;
  const front = s.y + s.height - 0.04;
  const height = INTERIOR_WALL_HEIGHT;
  const panel = lift(AVNU.indigo, 0.06);
  // The partitions, neon up their front edges and along their tops.
  for (const [a, b] of [[left + 0.02, left + 0.18], [right - 0.18, right - 0.02]] as const) {
    bin.add('body', boxGeometry(a, 0, back, b, height, front), aoPaint(panel, 0.08));
    bin.add('unlit', boxGeometry(a + 0.05, 0.16, front, b - 0.05, height - 0.08, front + 0.03), DEGEN.pink);
    bin.add('unlit', boxGeometry(a + 0.04, height, back, b - 0.04, height + 0.02, front), DEGEN.violet);
  }
  // The lintel across the mouth, its underline in the state colour.
  bin.add('body', boxGeometry(left + 0.18, 1.84, front - 0.24, right - 0.18, height, front), AVNU.navy);
  bin.add('accent', boxGeometry(left + 0.22, 1.81, front - 0.03, right - 0.22, 1.845, front + 0.02), 0xffffff);
  // Pink light pooled on the back room's floor.
  const pink = new Color(DEGEN.pink);
  ctx.shell.floor.addRGBA('light', flatQuad(left + 0.18, back, right - 0.18, s.y + 0.12, 0.013), (_x, _y, z) => [
    pink.r,
    pink.g,
    pink.b,
    0.22 * clamp01(0.4 + (z - back) / (s.y - back)),
  ]);

  // The back bar along the back wall, neon chip stacks and two glowing cubes on it.
  const [b0, b1] = [back + 0.02, back + 0.42];
  bin.add('body', boxGeometry(left + 0.22, 0, b0, right - 0.22, 0.86, b1), lift(AVNU.navy, 0.03));
  bin.add('unlit', boxGeometry(left + 0.22, 0.86, b1 - 0.02, right - 0.22, 0.885, b1 + 0.01), DEGEN.lime);
  const chips = [DEGEN.pink, DEGEN.lime, DEGEN.cyan, DEGEN.yellow, DEGEN.violet];
  for (let i = 0; i < 7; i++) {
    const u = left + 0.6 + i * 0.44;
    const stack = 2 + Math.floor(hash01(i, 7, 631) * 5);
    for (let k = 0; k < stack; k++) {
      bin.add('unlit', cylinderGeometry(u, 0.885 + k * 0.035, (b0 + b1) / 2, 0.075, 0.075, 0.03, 10), chips[(i + k) % chips.length]!);
    }
  }
  for (const [u, colour] of [[left + 0.9, DEGEN.cyan], [right - 0.9, DEGEN.pink]] as const) {
    bin.add('unlit', boxGeometry(u - 0.09, 0.885, (b0 + b1) / 2 - 0.09, u + 0.09, 1.065, (b0 + b1) / 2 + 0.09), colour);
  }

  // The bar: glossy black, a cyan edge along its top, pink light under it.
  const [z0, xa, xb] = [s.y + 0.12, left + 0.18, right - 0.18];
  bin.add('body', boxGeometry(xa, 0, z0, xb, 0.92, front), aoPaint(lift(AVNU.navy, 0.03), 0.1));
  bin.add('body', boxGeometry(xa, 0.92, z0 - 0.03, xb, 1, front + 0.03), lift(DEGEN.ink, 0.04));
  bin.add('unlit', boxGeometry(xa, 0.95, front + 0.03, xb, 0.985, front + 0.045), DEGEN.cyan);
  bin.add('unlit', boxGeometry(xa + 0.02, 0.02, front, xb - 0.02, 0.07, front + 0.02), DEGEN.pink);
  // Violet slats on the bar's ends, the status panel in the middle.
  const bf: Face = { normal: 'z+', plane: front };
  for (const [a, b] of [[xa, s.x], [s.x + s.width, xb]] as const) {
    for (let i = 0; i < 3; i++) {
      const u = a + ((b - a) * (i + 1)) / 4;
      bin.add('unlit', faceBox(bf, u - 0.025, 0.22, 0, u + 0.025, 0.78, 0.02), i === 1 ? DEGEN.lime : DEGEN.violet);
    }
  }
  bin.add('accent', boxGeometry(s.x + 0.14, 0.3, front, s.x + s.width - 0.14, 0.72, front + 0.03), 0xffffff);
  stationProps('degen', theme, bin, s.x + 0.1, s.x + s.width - 0.1, s.y + 0.14, s.y + s.height - 0.1);
  return { position: [(left + right) / 2, 2.02, front + 0.006], style: DEGEN_COUNTER_HEADER };
}

const POST_RED = 0xc23b2b;
const POST_BLUE = 0x2f5fa3;
const POST_CREAM = 0xfbf4e4;
const POST_BRASS = 0xc9a54a;
const POST_WOOD = 0x8a5a3a;
const POST_WOOD_LIGHT = 0xc49a6c;
const POST_WOOD_DARK = 0x5e3b25;

/** An airmail border along a face: red and blue slants on white, from u0 to u1 between v0 and v1. */
function airmailBand(bin: GeometryBin, face: Face, u0: number, u1: number, v0: number, v1: number, w: number): void {
  bin.add('body', faceBox(face, u0, v0, 0, u1, v1, w), POST_CREAM);
  const step = 0.2;
  const slant = (v1 - v0) * 0.55;
  for (let i = 0, u = u0 + 0.02; u + 0.1 + slant < u1; i++, u += step) {
    const points: [number, number][] = [
      [u, v0 + 0.02],
      [u + 0.09, v0 + 0.02],
      [u + 0.09 + slant, v1 - 0.02],
      [u + slant, v1 - 0.02],
    ];
    bin.add('body', facePrism(face, points, w, w + 0.006), i % 2 === 0 ? POST_RED : POST_BLUE);
  }
}

/**
 * The Post Office's counter (TRANSFER): a long wooden counter across the
 * room's north-west corner, an airmail border along its front, brass grilles
 * standing on it and one open service window, the station, with the scale
 * and a parcel on its sill and a service lamp on each jamb lit in its state. The label hangs over the window on an enamel
 * ticket, and SEND runs along the fascia above it between airmail stripes.
 * A red stamp machine stands at the counter's east end, and behind the
 * grilles is the sorting room: a mail sack and a sorting table in front of
 * the pigeonholes on the north wall (`postOfficeDecor`).
 */
function postOfficeCounter(ctx: CounterContext): CounterHeader {
  const { station: s, bin, theme, labels, textLabels, group } = ctx;
  const cx0 = s.x - 2;
  const cx1 = s.x + s.width + 3;
  const [w0, w1] = [s.x, s.x + s.width];
  const z0 = s.y + 0.08;
  const z1 = s.y + s.height - 0.04;
  const top = 1.03;
  const front: Face = { normal: 'z+', plane: z1 };
  // The counter: panelled wood under a lighter top, the airmail border along it.
  bin.add('body', boxGeometry(cx0 + 0.02, 0, z0, cx1, 0.95, z1), aoPaint(POST_WOOD, 0.1));
  bin.add('body', boxGeometry(cx0 + 0.02, 0.95, z0 - 0.02, cx1 + 0.02, top, z1 + 0.03), POST_WOOD_LIGHT);
  bin.add('body', boxGeometry(cx0 + 0.02, 0, z1, cx1, 0.12, z1 + 0.015), POST_WOOD_DARK);
  for (let x = cx0; x < cx1; x++) {
    if (x >= w0 && x < w1) continue;
    bin.add('body', faceBox(front, x + 0.12, 0.2, 0, x + 0.88, 0.56, 0.016), lift(POST_WOOD, -0.06));
  }
  airmailBand(bin, front, cx0 + 0.04, cx1 - 0.02, 0.64, 0.84, 0.012);
  bin.add('accent', boxGeometry(w0 + 0.14, 0.2, z1, w1 - 0.14, 0.56, z1 + 0.03), 0xffffff);

  // The grilles: brass bars on the counter, broken by the service window.
  const gz = s.y + 0.34;
  const [g0, g1] = [1.88, 1.06];
  for (let u = cx0 + 0.16; u < cx1 - 0.08; u += 0.15) {
    if (u > w0 - 0.06 && u < w1 + 0.06) continue;
    bin.add('body', boxGeometry(u - 0.014, top, gz - 0.014, u + 0.014, 1.97, gz + 0.014), POST_BRASS);
  }
  for (const [a, b] of [[cx0 + 0.02, w0], [w1, cx1]] as const) {
    for (const v of [g1, 1.5, g0]) bin.add('body', boxGeometry(a, v - 0.018, gz - 0.02, b, v + 0.018, gz + 0.02), POST_BRASS);
  }
  // Wooden posts at the ends and the window's jambs, the window's head, and the fascia.
  for (const u of [cx0 + 0.07, w0, w1, cx1 - 0.05]) {
    bin.add('body', boxGeometry(u - 0.05, top, gz - 0.06, u + 0.05, 1.98, gz + 0.06), POST_WOOD_DARK);
  }
  bin.add('body', boxGeometry(w0, 1.6, gz - 0.05, w1, 1.645, gz + 0.05), POST_BRASS);
  // A service lamp on each jamb, lit in the window's state.
  for (const u of [w0, w1]) {
    bin.add('body', faceBox({ normal: 'z+', plane: gz + 0.06 }, u - 0.06, 1.72, 0, u + 0.06, 1.9, 0.02), POST_BRASS);
    bin.add('accent', sphereGeometry(u, 1.81, gz + 0.12, 0.055, { widthSegments: 8, heightSegments: 5 }), 0xffffff);
  }
  const [f0, f1] = [1.98, 2.32];
  bin.add('body', boxGeometry(cx0 + 0.02, f0, gz - 0.1, cx1, f1, gz + 0.08), POST_BLUE);
  bin.add('body', boxGeometry(cx0 + 0.02, f1, gz - 0.12, cx1, f1 + 0.04, gz + 0.1), theme.wallTop);
  const fascia: Face = { normal: 'z+', plane: gz + 0.08 };
  const mid = (w0 + w1) / 2;
  airmailBand(bin, fascia, cx0 + 0.16, mid - 0.86, f0 + 0.08, f1 - 0.08, 0.004);
  airmailBand(bin, fascia, mid + 0.86, cx1 - 0.12, f0 + 0.08, f1 - 0.08, 0.004);
  const send = labels.sign(POST_OFFICE_SEND_TEXT, POST_OFFICE_SEND_SIGN);
  textLabels.push(send);
  send.object.position.set(mid, (f0 + f1) / 2, gz + 0.09);
  send.object.userData['area'] = 'post-office-send';
  group.add(send.object);
  // The scale and a parcel on the window's sill.
  stationProps('post-office', theme, bin, w0 + 0.1, w1 - 0.1, s.y + 0.14, s.y + s.height - 0.1);

  // The stamp machine at the east end: red, a cream window of stamps, a slot and a knob.
  const [m0, m1, mz0, mz1] = [cx1 + 0.12, cx1 + 0.88, s.y + 0.14, s.y + 0.9];
  bin.add('body', boxGeometry(m0, 0, mz0, m1, 1.5, mz1), aoPaint(POST_RED, 0.12));
  bin.add('body', boxGeometry(m0 - 0.04, 1.5, mz0 - 0.04, m1 + 0.04, 1.58, mz1 + 0.04), lift(POST_RED, -0.14));
  bin.add('body', boxGeometry(m0 - 0.02, 0, mz0 - 0.02, m1 + 0.02, 0.1, mz1 + 0.02), lift(POST_RED, -0.2));
  const mf: Face = { normal: 'z+', plane: mz1 };
  bin.add('body', faceBox(mf, m0, 1.36, 0, m1, 1.44, 0.006), POST_BLUE);
  bin.add('unlit', facePanel(mf, m0 + 0.12, 0.98, m1 - 0.12, 1.3, 0.008, 0.05), POST_CREAM);
  for (const [i, colour] of [POST_BLUE, POST_RED, POST_BLUE].entries()) {
    const u = m0 + 0.2 + i * 0.13;
    bin.add('unlit', faceBox(mf, u, 1.06, 0.01, u + 0.09, 1.2, 0.014), colour);
  }
  bin.add('body', faceBox(mf, m0 + 0.32, 0.84, 0, m0 + 0.44, 0.9, 0.012), 0x2b2b30);
  bin.add('body', faceDisc(mf, m1 - 0.16, 0.87, 0, 0.05, 0.05, 10), 0xc9ccd2);
  bin.add('body', faceBox(mf, m0 + 0.16, 0.52, 0, m1 - 0.16, 0.6, 0.012), 0x2b2b30);
  bin.add('body', faceBox(mf, m0 + 0.26, 0.44, 0.004, m1 - 0.26, 0.56, 0.05), POST_CREAM);
  bin.add('body', faceBox(mf, m0 + 0.26, 0.44, 0.05, m1 - 0.26, 0.46, 0.052), POST_BLUE);

  // The sorting room behind: a sorting table with bundles of letters, and a mail sack.
  const [t0, t1, tz0, tz1] = [cx1 - 3.3, cx1 - 0.4, s.y - 1.25, s.y - 0.55];
  bin.add('body', boxGeometry(t0, 0.76, tz0, t1, 0.82, tz1), POST_WOOD_LIGHT);
  for (const u of [t0 + 0.06, t1 - 0.06]) {
    for (const v of [tz0 + 0.06, tz1 - 0.06]) bin.add('body', boxGeometry(u - 0.03, 0, v - 0.03, u + 0.03, 0.76, v + 0.03), POST_WOOD_DARK);
  }
  for (let i = 0; i < 6; i++) {
    const u = t0 + 0.25 + i * 0.45;
    const colour = pick([0xf6efe0, 0xf4c7d0, 0xc9dcf2, 0xf2e2b0], hash01(i, 3, 641));
    const h = 0.05 + 0.1 * hash01(i, 4, 642);
    bin.add('body', boxGeometry(u - 0.14, 0.82, tz0 + 0.15, u + 0.14, 0.82 + h, tz1 - 0.2), colour);
  }
  const sx = cx0 + 0.75;
  const sz = s.y - 0.8;
  bin.add('body', sphereGeometry(sx, 0.36, sz, 0.34, { widthSegments: 8, heightSegments: 5, scaleY: 1.1 }), 0xd9c7a0);
  bin.add('body', cylinderGeometry(sx, 0.68, sz, 0.08, 0.14, 0.16, 8), 0xc4b088);
  bin.add('body', cylinderGeometry(sx, 0.3, sz, 0.345, 0.345, 0.08, 10), POST_BLUE);
  return { position: [mid, 1.81, gz + 0.03], style: POST_OFFICE_WINDOW_SIGN };
}

/**
 * The Bridge's gateway terminal (DEPOSIT), after the facade's steel pylons:
 * two black pylons, a green light cable up each face, carry a lintel whose
 * front is a departure board, the label heading it in NEAR's mono over rows
 * of flap cells. Between the pylons a portal of nested frames glows teal and
 * green over a pool of light, its nearest frame lit in the station's state,
 * and the terminal stands in its mouth: a black console with its route
 * screen on it.
 */
function gatewayTerminal(ctx: CounterContext): CounterHeader {
  const { station: s, bin, theme, shell } = ctx;
  const left = s.x - 2;
  const right = s.x + s.width + 2;
  const back = s.y - 2;
  const front = s.y + s.height - 0.04;
  const steel = lift(NEAR.raised, 0.1);
  const frame = lift(NEAR.hairline, 0.16);
  const pylonTop = 2.3;
  const pylons: ReadonlyArray<readonly [number, number, number]> = [
    [left + 0.1, s.x - 0.22, 1],
    [s.x + s.width + 0.22, right - 0.1, -1],
  ];
  const pf: Face = { normal: 'z+', plane: front };
  for (const [a, b, inward] of pylons) {
    bin.add('body', boxGeometry(a, 0, back + 0.25, b, pylonTop, front), aoPaint(steel, 0.1));
    bin.add('body', boxGeometry(a - 0.04, 0, back + 0.21, b + 0.04, 0.14, front + 0.04), NEAR.black);
    // A hairline frame on the front face, and the cable: a green line from the outer foot to the inner head.
    bin.add('body', faceBox(pf, a + 0.08, 0.2, 0, b - 0.08, 0.224, 0.008), frame);
    bin.add('body', faceBox(pf, a + 0.08, pylonTop - 0.12, 0, b - 0.08, pylonTop - 0.096, 0.008), frame);
    const [foot, head] = inward > 0 ? [a + 0.2, b - 0.16] : [b - 0.2, a + 0.16];
    bin.add('unlit', beamGeometry(faceToWorld(pf, foot, 0.3, 0.012), faceToWorld(pf, head, pylonTop - 0.2, 0.012), 0.012, 0.03), theme.floorAccent);
    crosshairMark(bin, pf, (a + b) / 2, 1.05, lift(NEAR.muted, 0.08));
  }
  // The lintel and its departure board.
  const [l0, l1] = [pylonTop, 3.05];
  bin.add('body', boxGeometry(left + 0.06, l0, front - 1.0, right - 0.06, l1, front), aoPaint(steel, 0.06, 3));
  bin.add('body', boxGeometry(left + 0.02, l1, front - 1.04, right - 0.02, l1 + 0.05, front + 0.03), NEAR.black);
  bin.add('unlit', facePanel(pf, left + 0.24, l0 + 0.05, right - 0.24, l1 - 0.05, 0.006, 0.04), NEAR.black);
  // Two rows of flap cells, lit in words: a route (white), a lane (teal) and
  // its status, the top row's green, the lower one's amber, still pending.
  // Shapes only, never letters or figures.
  const rows: ReadonlyArray<readonly [number, number, string]> = [
    [2.54, 2.66, 'wwww.wwwwwww.tt..ggg'],
    [2.39, 2.51, 'www.wwwwwwww..tt.aaa'],
  ];
  const lit: Readonly<Record<string, number>> = { w: NEAR.white, t: NEAR.teal, g: theme.floorAccent, a: NEAR.amber };
  const [c0, c1] = [left + 0.34, right - 0.34];
  for (const [v0, v1, word] of rows) {
    const pitch = (c1 - c0) / word.length;
    [...word].forEach((cell, i) => {
      const u = c0 + i * pitch;
      bin.add('unlit', faceBox(pf, u + 0.012, v0, 0.008, u + pitch - 0.012, v1, 0.012), lift(NEAR.elevated, 0.04));
      bin.add('unlit', faceBox(pf, u + 0.012, (v0 + v1) / 2 - 0.004, 0.012, u + pitch - 0.012, (v0 + v1) / 2 + 0.004, 0.0125), NEAR.black);
      const colour = lit[cell];
      if (colour !== undefined) bin.add('unlit', faceBox(pf, u + 0.05, v0 + 0.028, 0.0125, u + pitch - 0.05, v1 - 0.028, 0.016), colour);
    });
  }

  // The portal: nested frames between the pylons, the nearest in the state colour.
  const [p0, p1] = [s.x - 0.22, s.x + s.width + 0.22];
  const depths = [front - 1.0, front - 1.7, front - 2.4];
  depths.forEach((z, k) => {
    const [a, b, h] = [p0 + 0.1 + k * 0.14, p1 - 0.1 - k * 0.14, pylonTop - 0.08 - k * 0.16];
    const key = k === 0 ? 'accent' : 'unlit';
    const colour = k === 0 ? 0xffffff : k === 1 ? NEAR.teal : mixHex(NEAR.teal, NEAR.periwinkle, 0.5);
    const t = 0.05;
    bin.add(key, boxGeometry(a, 0.02, z - 0.03, a + t, h, z + 0.03), colour);
    bin.add(key, boxGeometry(b - t, 0.02, z - 0.03, b, h, z + 0.03), colour);
    bin.add(key, boxGeometry(a, h - t, z - 0.03, b, h, z + 0.03), colour);
  });
  const glow = new Color(NEAR.teal);
  shell.floor.addRGBA('light', flatQuad(p0 + 0.05, back, p1 - 0.05, s.y + 0.1, 0.013), (_x, _y, z) => [
    glow.r,
    glow.g,
    glow.b,
    0.3 * clamp01((z - back) / (s.y - back)),
  ]);
  // The portal's far side: a wash of green light rising off the floor behind the last frame.
  const far: Face = { normal: 'z+', plane: depths[2]! - 0.12 };
  const green = new Color(theme.floorAccent);
  shell.floor.addRGBA('light', faceQuad(far, p0 + 0.3, 0.02, p1 - 0.3, pylonTop - 0.3, 0), (_x, y) => [
    green.r,
    green.g,
    green.b,
    0.32 * (1 - clamp01(y / (pylonTop - 0.3))) ** 1.4,
  ]);

  // The terminal: a black console, a green edge, the status panel and its route screen.
  const [k0, k1, kz0] = [s.x + 0.06, s.x + s.width - 0.06, s.y + 0.1];
  bin.add('body', boxGeometry(k0, 0, kz0, k1, 0.92, front), aoPaint(lift(NEAR.raised, 0.06), 0.1));
  bin.add('body', boxGeometry(k0 - 0.03, 0.92, kz0 - 0.03, k1 + 0.03, 1, front + 0.03), lift(NEAR.hairline, 0.12));
  bin.add('unlit', boxGeometry(k0 - 0.03, 0.96, front + 0.03, k1 + 0.03, 0.985, front + 0.045), theme.floorAccent);
  bin.add('accent', boxGeometry(s.x + 0.18, 0.3, front, s.x + s.width - 0.18, 0.7, front + 0.03), 0xffffff);
  stationProps('bridge', theme, bin, s.x + 0.1, s.x + s.width - 0.1, s.y + 0.14, s.y + s.height - 0.1);
  return { position: [(left + right) / 2, 2.84, front + 0.02], style: NEAR_DEPARTURE_HEADER };
}

/** A NEAR Intents crosshair, a small plus standing just proud of a face. */
function crosshairMark(bin: GeometryBin, face: Face, u: number, v: number, colour: number): void {
  bin.add('body', faceBox(face, u - 0.06, v - 0.007, 0, u + 0.06, v + 0.007, 0.01), colour);
  bin.add('body', faceBox(face, u - 0.007, v - 0.06, 0, u + 0.007, v + 0.06, 0.01), colour);
}

/**
 * Free-standing furniture on a floor's `prop` fixtures, on the floor's own
 * lit and glow bins, so it spends no draw call: avnu's traders' pods, the
 * Degen floor's neon high tables, the Post Office's pillar box and writing
 * desk, and the Bridge's lounge seats facing its gateway.
 */
function fixtureProps(map: FixedRoomLevelMap, theme: RoomTheme, shell: InteriorShell): void {
  for (const fixture of map.fixtures) {
    switch (fixture.prop) {
      case 'trading-pod':
        tradingPod(shell.floor, fixture);
        break;
      case 'high-table':
        highTable(shell.floor, fixture);
        break;
      case 'pillar-box':
        roomPillarBox(shell.floor, fixture);
        break;
      case 'writing-desk':
        writingDesk(shell.floor, fixture);
        break;
      case 'bench':
        loungeSeats(shell.floor, fixture, theme);
        break;
      case undefined:
        break;
    }
  }
}

/** A traders' pod: a navy desk, back-to-back monitors down its middle, blue light along both edges. */
function tradingPod(bin: GeometryBin, r: FixedRoomRect): void {
  const [x0, x1, z0, z1] = [r.x + 0.1, r.x + r.width - 0.1, r.y + 0.12, r.y + r.height - 0.12];
  const zc = (z0 + z1) / 2;
  bin.add('floor', boxGeometry(x0 + 0.06, 0, z0 + 0.06, x1 - 0.06, 0.72, z1 - 0.06), aoPaint(AVNU.card, 0.1));
  bin.add('floor', boxGeometry(x0, 0.72, z0, x1, 0.8, z1), lift(AVNU.navy, 0.05));
  for (const z of [z0 - 0.005, z1 - 0.025]) bin.add('glow', boxGeometry(x0, 0.74, z, x1, 0.77, z + 0.03), AVNU.blue);
  const count = Math.max(1, Math.round((x1 - x0) / 0.95));
  const step = (x1 - x0) / count;
  for (let i = 0; i < count; i++) {
    const u = x0 + step * (i + 0.5);
    bin.add('floor', boxGeometry(u - 0.04, 0.8, zc - 0.04, u + 0.04, 0.92, zc + 0.04), AVNU.navy);
    bin.add('floor', boxGeometry(u - 0.36, 0.9, zc - 0.07, u + 0.36, 1.28, zc + 0.07), AVNU.navy);
    for (const [plane, normal] of [[zc + 0.07, 'z+'], [zc - 0.07, 'z-']] as const) {
      const face: Face = { normal, plane };
      bin.add('glow', facePanel(face, u - 0.32, 0.93, u + 0.32, 1.25, 0.004, 0.03), AVNU.card);
      for (let k = 0; k < 4; k++) {
        const h = 0.05 + 0.2 * hash01(Math.round(u * 10), k + (normal === 'z+' ? 0 : 7), 661);
        const bu = u - 0.22 + k * 0.12;
        bin.add('glow', faceBox(face, bu, 0.97, 0.006, bu + 0.07, 0.97 + h, 0.01), k % 2 === 0 ? AVNU.blue : AVNU.lightBlue);
      }
    }
  }
}

/** A neon high table: a black round top ringed in pink on a pole, two glowing drinks on it. */
function highTable(bin: GeometryBin, r: FixedRoomRect): void {
  const [x, z] = [r.x + r.width / 2, r.y + r.height / 2];
  bin.add('floor', cylinderGeometry(x, 0, z, 0.26, 0.3, 0.06, 12), lift(AVNU.navy, 0.03));
  bin.add('floor', cylinderGeometry(x, 0.06, z, 0.05, 0.05, 0.94, 8), lift(AVNU.indigo, 0.08));
  bin.add('floor', cylinderGeometry(x, 1, z, 0.4, 0.4, 0.05, 16), DEGEN.ink);
  bin.add('glow', cylinderGeometry(x, 0.99, z, 0.415, 0.415, 0.03, 16), DEGEN.pink);
  bin.add('glow', cylinderGeometry(x - 0.12, 1.05, z + 0.06, 0.045, 0.04, 0.16, 8), DEGEN.cyan);
  bin.add('glow', cylinderGeometry(x + 0.14, 1.05, z - 0.04, 0.045, 0.04, 0.13, 8), DEGEN.lime);
}

/** The street's pillar box, a little larger indoors: red, a dark base and slot, a cream plate. */
function roomPillarBox(bin: GeometryBin, r: FixedRoomRect): void {
  const [x, z] = [r.x + r.width / 2, r.y + r.height / 2];
  const red = 0xc8302c;
  const dark = 0x2a2a2e;
  bin.add('floor', cylinderGeometry(x, 0, z, 0.3, 0.3, 0.1, 12), dark);
  bin.add('floor', cylinderGeometry(x, 0.1, z, 0.26, 0.27, 1.18, 12), red);
  bin.add('floor', cylinderGeometry(x, 1.28, z, 0.29, 0.29, 0.08, 12), red);
  bin.add('floor', sphereGeometry(x, 1.36, z, 0.27, { widthSegments: 12, heightSegments: 3, hemisphere: true, scaleY: 0.6 }), red);
  bin.add('floor', boxGeometry(x - 0.15, 1.0, z + 0.2, x + 0.15, 1.05, z + 0.275), dark);
  bin.add('floor', boxGeometry(x - 0.1, 0.66, z + 0.22, x + 0.1, 0.82, z + 0.27), 0xf3ead6);
}

/** A standing desk for forms: wood, forms and an inkwell on its top, the airmail border along its front. */
function writingDesk(bin: GeometryBin, r: FixedRoomRect): void {
  const [x0, x1, z0, z1] = [r.x + 0.12, r.x + r.width - 0.12, r.y + 0.2, r.y + r.height - 0.2];
  for (const x of [x0, x1 - 0.08]) bin.add('floor', boxGeometry(x, 0, z0, x + 0.08, 1.0, z1), POST_WOOD_DARK);
  bin.add('floor', boxGeometry(x0, 0.28, z0 + 0.05, x1, 0.32, z1 - 0.05), POST_WOOD);
  bin.add('floor', boxGeometry(x0 - 0.04, 1.0, z0 - 0.04, x1 + 0.04, 1.06, z1 + 0.04), POST_WOOD_LIGHT);
  const front: Face = { normal: 'z+', plane: z1 + 0.04 };
  bin.add('floor', faceBox(front, x0 + 0.1, 1.0, 0, x1 - 0.1, 1.06, 0.004), POST_CREAM);
  for (let u = x0 + 0.14, i = 0; u + 0.1 < x1 - 0.1; u += 0.16, i++) {
    bin.add('floor', faceBox(front, u, 1.008, 0.004, u + 0.08, 1.052, 0.008), i % 2 === 0 ? POST_RED : POST_BLUE);
  }
  for (let i = 0; i < 4; i++) {
    const u = x0 + 0.35 + i * 0.6;
    if (u + 0.2 > x1) break;
    bin.add('floor', boxGeometry(u - 0.16, 1.06, z0 + 0.12, u + 0.16, 1.07, z1 - 0.1), i % 2 === 0 ? POST_CREAM : 0xf4c7d0);
  }
  bin.add('floor', cylinderGeometry(x1 - 0.3, 1.06, (z0 + z1) / 2, 0.05, 0.06, 0.08, 8), 0x2b2b30);
}

/** Lounge seats facing the gateway: three black seats on a beam, a green line along their backs. */
function loungeSeats(bin: GeometryBin, r: FixedRoomRect, theme: RoomTheme): void {
  const [x0, x1, z0, z1] = [r.x + 0.1, r.x + r.width - 0.1, r.y + 0.18, r.y + r.height - 0.14];
  const seat = lift(NEAR.raised, 0.12);
  bin.add('floor', boxGeometry(x0 + 0.1, 0.3, z0 + 0.2, x1 - 0.1, 0.36, z1 - 0.2), NEAR.black);
  for (const x of [x0 + 0.3, x1 - 0.3]) bin.add('floor', boxGeometry(x - 0.05, 0, z0 + 0.2, x + 0.05, 0.3, z1 - 0.2), NEAR.black);
  const count = Math.max(1, Math.round((x1 - x0) / 0.9));
  const step = (x1 - x0) / count;
  for (let i = 0; i < count; i++) {
    const a = x0 + step * i + 0.05;
    const b = x0 + step * (i + 1) - 0.05;
    bin.add('floor', boxGeometry(a, 0.36, z0, b, 0.46, z1 - 0.1), seat);
    bin.add('floor', boxGeometry(a, 0.46, z1 - 0.12, b, 0.98, z1), seat);
    bin.add('glow', boxGeometry(a + 0.06, 0.9, z1, b - 0.06, 0.93, z1 + 0.012), theme.floorAccent);
  }
}

/** Themed props on the counter top (y = 1), in the station's style. */
function stationProps(
  style: StationPropStyle,
  theme: RoomTheme,
  bin: GeometryBin,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): void {
  const cz = (z0 + z1) / 2;
  const top = 1;
  switch (style) {
    case 'strk20': {
      // A slim black terminal with one burnt-orange line: nothing else lit.
      const cx = (x0 + x1) / 2;
      const face: Face = { normal: 'z+', plane: z0 + 0.14 };
      bin.add('body', boxGeometry(cx - 0.34, top, z0 + 0.06, cx + 0.34, top + 0.03, z1 - 0.06), lift(STRK20.surface, 0.08));
      bin.add('body', faceBox(face, cx - 0.36, top + 0.03, 0, cx + 0.36, top + 0.4, 0.04), lift(STRK20.raised, 0.06));
      bin.add('unlit', faceBox(face, cx - 0.3, top + 0.09, 0.04, cx + 0.3, top + 0.34, 0.043), lift(STRK20.black, 0.02));
      bin.add('unlit', faceBox(face, cx - 0.3, top + 0.1, 0.043, cx - 0.02, top + 0.13, 0.046), STRK20.orange);
      bin.add('unlit', faceBox(face, cx - 0.3, top + 0.2, 0.043, cx + 0.14, top + 0.215, 0.046), STRK20.blush);
      bin.add('unlit', faceBox(face, cx - 0.3, top + 0.25, 0.043, cx + 0.22, top + 0.265, 0.046), STRK20.peach);
      break;
    }
    case 'avnu': {
      // A small swap card: two token fields and the primary pill button.
      const cx = (x0 + x1) / 2;
      const face: Face = { normal: 'z+', plane: z0 + 0.12 };
      bin.add('body', boxGeometry(cx - 0.05, top, z0 + 0.06, cx + 0.05, top + 0.1, z0 + 0.14), AVNU.navy);
      bin.add('body', faceBox(face, cx - 0.44, top + 0.08, 0, cx + 0.44, top + 0.56, 0.05), AVNU.navy);
      bin.add('unlit', facePanel(face, cx - 0.4, top + 0.12, cx + 0.4, top + 0.52, 0.052, 0.06), AVNU.card);
      bin.add('unlit', facePanel(face, cx - 0.34, top + 0.38, cx + 0.34, top + 0.47, 0.055, 0.045), AVNU.navy);
      bin.add('unlit', facePanel(face, cx - 0.34, top + 0.27, cx + 0.34, top + 0.36, 0.055, 0.045), AVNU.navy);
      bin.add('unlit', facePanel(face, cx - 0.31, top + 0.4, cx - 0.25, top + 0.45, 0.058, 0.03), AVNU.lightBlue);
      bin.add('unlit', facePanel(face, cx - 0.31, top + 0.29, cx - 0.25, top + 0.34, 0.058, 0.03), AVNU.slate);
      bin.add('unlit', facePanel(face, cx - 0.34, top + 0.15, cx + 0.34, top + 0.24, 0.055, 0.045), AVNU.blue);
      break;
    }
    case 'degen': {
      // The degen swap card: avnu's pill fields, the call to action in hot
      // pink, a lime and a cyan token dot.
      const cx = (x0 + x1) / 2;
      const face: Face = { normal: 'z+', plane: z0 + 0.12 };
      bin.add('body', boxGeometry(cx - 0.05, top, z0 + 0.06, cx + 0.05, top + 0.1, z0 + 0.14), AVNU.navy);
      bin.add('body', faceBox(face, cx - 0.44, top + 0.08, 0, cx + 0.44, top + 0.56, 0.05), AVNU.navy);
      bin.add('unlit', facePanel(face, cx - 0.42, top + 0.1, cx + 0.42, top + 0.54, 0.051, 0.07), DEGEN.pink);
      bin.add('unlit', facePanel(face, cx - 0.4, top + 0.12, cx + 0.4, top + 0.52, 0.052, 0.06), AVNU.card);
      bin.add('unlit', facePanel(face, cx - 0.34, top + 0.38, cx + 0.34, top + 0.47, 0.055, 0.045), AVNU.navy);
      bin.add('unlit', facePanel(face, cx - 0.34, top + 0.27, cx + 0.34, top + 0.36, 0.055, 0.045), AVNU.navy);
      bin.add('unlit', facePanel(face, cx - 0.31, top + 0.4, cx - 0.25, top + 0.45, 0.058, 0.03), DEGEN.lime);
      bin.add('unlit', facePanel(face, cx - 0.31, top + 0.29, cx - 0.25, top + 0.34, 0.058, 0.03), DEGEN.cyan);
      bin.add('unlit', facePanel(face, cx - 0.34, top + 0.15, cx + 0.34, top + 0.24, 0.055, 0.045), DEGEN.pink);
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
      // A slim black terminal showing one route (a chain, a green line,
      // Starknet) over the green call-to-action bar.
      const cx = (x0 + x1) / 2;
      const face: Face = { normal: 'z+', plane: z0 + 0.14 };
      bin.add('body', boxGeometry(cx - 0.36, top, z0 + 0.06, cx + 0.36, top + 0.03, z1 - 0.06), lift(NEAR.raised, 0.08));
      bin.add('body', faceBox(face, cx - 0.38, top + 0.03, 0, cx + 0.38, top + 0.44, 0.04), lift(NEAR.raised, 0.06));
      bin.add('unlit', faceBox(face, cx - 0.32, top + 0.09, 0.04, cx + 0.32, top + 0.38, 0.043), lift(NEAR.black, 0.02));
      bin.add('unlit', faceBox(face, cx - 0.25, top + 0.265, 0.043, cx - 0.2, top + 0.315, 0.046), NEAR.muted);
      bin.add('unlit', faceBox(face, cx - 0.2, top + 0.284, 0.043, cx + 0.2, top + 0.296, 0.046), theme.floorAccent);
      bin.add('unlit', faceBox(face, cx + 0.2, top + 0.26, 0.043, cx + 0.26, top + 0.32, 0.046), NEAR.white);
      bin.add('unlit', faceBox(face, cx - 0.25, top + 0.13, 0.043, cx + 0.26, top + 0.19, 0.046), theme.floorAccent);
      break;
    }
    case 'vesu':
      vesuCounter(bin, x0, x1, z0, z1, top);
      break;
    case 'vesu-borrow':
      vesuBorrowCounter(bin, x0, x1, z0, z1, top);
      break;
    case 'endur':
      endurCounter(bin, x0, x1, z0, z1, top);
      break;
    case 'plain':
      break;
  }
}

/**
 * Endur's staking counter, light on the Bank's dark floor: a white card with
 * a mint amount field and the green pill (dark mark on it: text on Endur's
 * green is never white), a green droplet standing on the counter, and a
 * dark-green wave running along the front above the status panel.
 */
function endurCounter(bin: GeometryBin, x0: number, x1: number, z0: number, z1: number, top: number): void {
  const cx = (x0 + x1) / 2;
  const face: Face = { normal: 'z+', plane: z0 + 0.12 };
  bin.add('body', boxGeometry(cx - 0.05, top, z0 + 0.06, cx + 0.05, top + 0.1, z0 + 0.12), ENDUR.dark);
  bin.add('body', facePanel(face, cx - 0.45, top + 0.08, cx + 0.45, top + 0.6, 0.004, 0.08), ENDUR.border);
  bin.add('body', facePanel(face, cx - 0.43, top + 0.1, cx + 0.43, top + 0.58, 0.012, 0.07), ENDUR.card);
  bin.add('body', facePanel(face, cx - 0.35, top + 0.37, cx + 0.35, top + 0.5, 0.02, 0.065), ENDUR.band);
  bin.add('body', faceDisc(face, cx - 0.27, top + 0.435, 0.02, 0.034, 0.008, 10), ENDUR.green);
  bin.add('body', facePanel(face, cx + 0.02, top + 0.422, cx + 0.27, top + 0.448, 0.026, 0.013), ENDUR.dark);
  bin.add('body', facePanel(face, cx - 0.35, top + 0.18, cx + 0.35, top + 0.3, 0.02, 0.06), ENDUR.green);
  bin.add('body', facePanel(face, cx - 0.1, top + 0.228, cx + 0.1, top + 0.252, 0.026, 0.012), ENDUR.dark);
  // The droplet: a sphere drawn up into a cone, the logo's idea, not its mark.
  const dx = x1 - 0.2;
  const dz = (z0 + z1) / 2 + 0.08;
  const r = 0.085;
  bin.add('body', sphereGeometry(dx, top + r, dz, r, { widthSegments: 10, heightSegments: 6 }), ENDUR.green);
  bin.add('body', coneGeometry(dx, top + r * 1.25, dz, r * 0.93, 0.19, 10), ENDUR.green);
  // The wave, as short strokes along a sine.
  const front: Face = { normal: 'z+', plane: z1 };
  const steps = 18;
  const wave = (i: number): number => 0.815 + 0.035 * Math.sin((i / steps) * Math.PI * 4);
  for (let i = 0; i < steps; i++) {
    const ua = x0 + 0.12 + ((x1 - x0 - 0.24) * i) / steps;
    const ub = x0 + 0.12 + ((x1 - x0 - 0.24) * (i + 1)) / steps;
    bin.add('body', beamGeometry(faceToWorld(front, ua, wave(i), 0.012), faceToWorld(front, ub, wave(i + 1), 0.012), 0.012, 0.024), ENDUR.greenDeep);
  }
}

/**
 * Vesu's lending counter: a white desk under an ink top with a supply card
 * standing on it in the app's idiom (a token field with its disc and a
 * periwinkle tab, an amount field, a rate bar, the electric-blue primary
 * button), and the V standing at its east end, a desk-sized mark in the
 * logo's light-page gradients. Bars and fields only: no figure on it.
 */
function vesuCounter(bin: GeometryBin, x0: number, x1: number, z0: number, z1: number, top: number): void {
  const cx = (x0 + x1) / 2 - 0.16;
  const face: Face = { normal: 'z+', plane: z0 + 0.12 };
  bin.add('body', boxGeometry(cx - 0.05, top, z0 + 0.06, cx + 0.05, top + 0.1, z0 + 0.12), VESU.ink);
  bin.add('body', facePanel(face, cx - 0.46, top + 0.07, cx + 0.46, top + 0.6, 0.004, 0.08), VESU.fill);
  bin.add('unlit', facePanel(face, cx - 0.44, top + 0.09, cx + 0.44, top + 0.58, 0.012, 0.07), VESU.white);
  // The token field: a disc, a name bar and the periwinkle tab.
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.42, cx + 0.38, top + 0.53, 0.018, 0.04), VESU.page);
  bin.add('unlit', faceDisc(face, cx - 0.31, top + 0.475, 0.018, 0.035, 0.006, 12), 0x6d4df2);
  bin.add('unlit', facePanel(face, cx - 0.24, top + 0.466, cx - 0.02, top + 0.484, 0.024, 0.009), VESU.muted);
  bin.add('unlit', facePanel(face, cx + 0.16, top + 0.448, cx + 0.34, top + 0.502, 0.024, 0.027), VESU.blueSoft);
  // The amount field, and the rate bar under it.
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.29, cx + 0.38, top + 0.39, 0.018, 0.04), VESU.page);
  bin.add('unlit', facePanel(face, cx - 0.32, top + 0.33, cx + 0.02, top + 0.35, 0.024, 0.01), VESU.ink);
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.245, cx - 0.12, top + 0.265, 0.018, 0.01), VESU.blueText);
  // The primary button.
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.12, cx + 0.38, top + 0.21, 0.018, 0.04), VESU.blue);
  bin.add('unlit', facePanel(face, cx - 0.1, top + 0.157, cx + 0.1, top + 0.173, 0.024, 0.008), VESU.white);
  // The V, on the desk's east end.
  addVesuMark(bin, 'unlit', { normal: 'z+', plane: (z0 + z1) / 2 }, x1 - 0.24, top, 0.34, 0, 0.05, 'light');
}

/**
 * Vesu's borrowing counter (D-083), the lending counter's twin: the same desk
 * with a loan card standing on it in the app's idiom, a health bar along its
 * top (segments running Vesu's blues from pale to night, an ink marker
 * standing on it), a collateral field over a debt field (each a token disc
 * and a name bar, the debt's with the periwinkle tab) and the electric-blue
 * primary button. Bars, discs and panels only: no figure, rate or symbol on it.
 */
function vesuBorrowCounter(bin: GeometryBin, x0: number, x1: number, z0: number, z1: number, top: number): void {
  const cx = (x0 + x1) / 2 - 0.16;
  const face: Face = { normal: 'z+', plane: z0 + 0.12 };
  bin.add('body', boxGeometry(cx - 0.05, top, z0 + 0.06, cx + 0.05, top + 0.1, z0 + 0.12), VESU.ink);
  bin.add('body', facePanel(face, cx - 0.46, top + 0.07, cx + 0.46, top + 0.66, 0.004, 0.08), VESU.fill);
  bin.add('unlit', facePanel(face, cx - 0.44, top + 0.09, cx + 0.44, top + 0.64, 0.012, 0.07), VESU.white);
  // The health bar along the top, where the status beacon never hides it:
  // pale to night in segments, the ink marker standing on it.
  const segments = [VESU.blueSoft, VESU.blue, VESU.blueText, VESU.night];
  const [b0, b1, gap] = [cx - 0.38, cx + 0.38, 0.014];
  const step = (b1 - b0 + gap) / segments.length;
  segments.forEach((hex, i) => {
    bin.add('unlit', facePanel(face, b0 + i * step, top + 0.535, b0 + (i + 1) * step - gap, top + 0.57, 0.018, 0.012), hex);
  });
  const marker = b0 + (b1 - b0) * 0.34;
  bin.add('unlit', facePanel(face, marker - 0.011, top + 0.515, marker + 0.011, top + 0.59, 0.026, 0.006), VESU.ink);
  // The collateral field: a night disc, a name bar and an ink amount bar.
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.375, cx + 0.38, top + 0.475, 0.018, 0.04), VESU.page);
  bin.add('unlit', faceDisc(face, cx - 0.31, top + 0.425, 0.018, 0.033, 0.006, 12), VESU.night);
  bin.add('unlit', facePanel(face, cx - 0.24, top + 0.416, cx - 0.04, top + 0.434, 0.024, 0.009), VESU.muted);
  bin.add('unlit', facePanel(face, cx + 0.08, top + 0.416, cx + 0.32, top + 0.434, 0.024, 0.009), VESU.ink);
  // The debt field: a blue disc, a name bar and the periwinkle tab.
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.255, cx + 0.38, top + 0.355, 0.018, 0.04), VESU.page);
  bin.add('unlit', faceDisc(face, cx - 0.31, top + 0.305, 0.018, 0.033, 0.006, 12), VESU.blue);
  bin.add('unlit', facePanel(face, cx - 0.24, top + 0.296, cx - 0.04, top + 0.314, 0.024, 0.009), VESU.muted);
  bin.add('unlit', facePanel(face, cx + 0.14, top + 0.28, cx + 0.34, top + 0.33, 0.024, 0.025), VESU.blueSoft);
  bin.add('unlit', facePanel(face, cx + 0.18, top + 0.298, cx + 0.3, top + 0.312, 0.028, 0.007), VESU.blueText);
  // The primary button.
  bin.add('unlit', facePanel(face, cx - 0.38, top + 0.12, cx + 0.38, top + 0.21, 0.018, 0.04), VESU.blue);
  bin.add('unlit', facePanel(face, cx - 0.1, top + 0.157, cx + 0.1, top + 0.173, 0.024, 0.008), VESU.white);
}

function roomFloorColor(theme: RoomTheme, map: FixedRoomLevelMap): (x: number, y: number) => Color {
  return (x, y) => {
    const tile = map.tiles[y]?.[x];
    const seed = hash01(x, y, 201);
    if (tile === 'wall') return shade(theme.floorB, -0.1);
    // The brand rooms' floors take almost no jitter: on the dark ones it
    // reads as grime, on Vesu's white pages as smudges.
    const quiet =
      theme.decor === 'avnu' || theme.decor === 'degen' || theme.decor === 'strk20' || theme.decor === 'bridge' || theme.decor === 'vesu';
    return jitterColor((x + y) % 2 === 0 ? theme.floorA : theme.floorB, seed, quiet ? 0.01 : 0.022);
  };
}

/** The exit: a glowing mat, chevrons pointing out, bollards and a pool of light. */
function exitDecor(map: FixedRoomLevelMap, theme: RoomTheme, shell: InteriorShell): void {
  const exit = map.exit;
  if (!exit) return;
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

/** A flat chevron pointing south (+Z), or north when `north` is set. */
function chevron(bin: GeometryBin, cx: number, zc: number, colour: number, north = false, scale = 1): void {
  const s = north ? -1 : 1;
  const tip: [number, number] = [cx, zc + 0.14 * s * scale];
  for (const side of [-1, 1]) {
    const end: [number, number] = [cx + side * 0.3 * scale, zc - 0.14 * s * scale];
    bin.add(
      'glow',
      flatPolygon([tip, [tip[0], tip[1] - 0.1 * s * scale], [end[0], end[1] - 0.1 * s * scale], end], 0.01),
      colour,
    );
  }
}

/**
 * A lift pad (the Exchange tower): a dark plate edged in light, chevrons
 * pointing the way in (north up the tower, south down it), a pool of light
 * and a label naming where it goes. A pad backing onto the north wall gets
 * lift doors in it; one by the low south ledge gets a lit sill, since the
 * camera looks over that wall.
 */
function liftDecor(
  map: FixedRoomLevelMap,
  theme: RoomTheme,
  shell: InteriorShell,
  labels: LabelFactory,
  textLabels: TextLabel[],
  group: Group,
): void {
  const glow = theme.liftGlow ?? theme.exitGlow;
  const c = new Color(glow);
  for (const lift of map.lifts) {
    const x0 = lift.x;
    const x1 = lift.x + lift.width;
    const z0 = lift.y;
    const z1 = lift.y + lift.height;
    const up = liftGoesUp(map.level, lift.to);
    const e = 0.05;
    shell.floor.add('floor', flatQuad(x0 + 0.08, z0 + 0.08, x1 - 0.08, z1 - 0.08, 0.006), shade(theme.floorB, -0.16));
    shell.floor.add('glow', flatQuad(x0 + 0.08, z0 + 0.08, x1 - 0.08, z0 + 0.08 + e, 0.009), glow);
    shell.floor.add('glow', flatQuad(x0 + 0.08, z1 - 0.08 - e, x1 - 0.08, z1 - 0.08, 0.009), glow);
    shell.floor.add('glow', flatQuad(x0 + 0.08, z0 + 0.08, x0 + 0.08 + e, z1 - 0.08, 0.009), glow);
    shell.floor.add('glow', flatQuad(x1 - 0.08 - e, z0 + 0.08, x1 - 0.08, z1 - 0.08, 0.009), glow);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    for (const offset of [-0.17, 0.17]) chevron(shell.floor, cx, cz + offset * (up ? 1 : -1), glow, up, 0.8);
    shell.floor.addRGBA('light', flatQuad(x0, z0, x1, z1, 0.013), () => [c.r, c.g, c.b, 0.24]);
    if (z0 === 1) liftDoors(shell.walls.north, x0 + 0.1, x1 - 0.1, glow, up);
    if (z1 === map.height - 1) {
      // The south ledge is low so the camera sees in; a lit sill marks the lift.
      const top = INTERIOR_SOUTH_WALL_HEIGHT + 0.05;
      shell.south.add('unlit', boxGeometry(x0 + 0.12, top, z1 + 0.12, x1 - 0.12, top + 0.025, z1 + 0.3), glow);
    }
    const label = labels.floating(liftLabelText(map.level, lift.to), { lineHeight: 0.26, ...theme.label });
    textLabels.push(label);
    label.object.position.set(cx, STATION_LABEL_Y + 0.12, cz);
    label.object.userData['lift'] = lift.to;
    group.add(label.object);
  }
}

/** Steel lift doors in a wall, a lit seam between the leaves, the way it goes lit above. */
function liftDoors(wall: InteriorWall, u0: number, u1: number, glow: number, up: boolean): void {
  if (!inSpans(wall, u0 - 0.1, u1 + 0.1)) return;
  const f = wall.face;
  const steel = lift(AVNU.slate, -0.12);
  const leaf = lift(AVNU.slate, -0.28);
  const mid = (u0 + u1) / 2;
  wall.bins.add('body', faceBox(f, u0 - 0.1, 0, 0, u0, 1.92, 0.09), steel);
  wall.bins.add('body', faceBox(f, u1, 0, 0, u1 + 0.1, 1.92, 0.09), steel);
  wall.bins.add('body', faceBox(f, u0 - 0.1, 1.8, 0, u1 + 0.1, 1.92, 0.09), steel);
  wall.bins.add('body', faceBox(f, u0, 0, 0, mid - 0.012, 1.8, 0.06), leaf);
  wall.bins.add('body', faceBox(f, mid + 0.012, 0, 0, u1, 1.8, 0.06), leaf);
  wall.bins.add('unlit', faceBox(f, mid - 0.012, 0.04, 0, mid + 0.012, 1.76, 0.05), glow);
  const [a, b] = up ? [1.83, 1.9] : [1.9, 1.83];
  wall.bins.add('unlit', facePrism(f, [[mid - 0.07, a], [mid + 0.07, a], [mid, b]], 0.09, 0.1), glow);
}

/** A convex polygon given in face coordinates (u, v), standing `w0` to `w1` out of the face. */
function facePrism(face: Face, points: readonly (readonly [number, number])[], w0: number, w1: number): BufferGeometry {
  const loop = points.map(([u, v]) => [u, v] as [number, number]);
  switch (face.normal) {
    case 'z+':
      return prismZ(loop, face.plane + w0, face.plane + w1);
    case 'z-':
      return prismZ(loop, face.plane - w1, face.plane - w0);
    case 'x+':
      return prismX(loop, face.plane + w0, face.plane + w1);
    case 'x-':
      return prismX(loop, face.plane - w1, face.plane - w0);
  }
}

/** The rotation that turns a sign (it faces +Z) to face out of a wall. */
function faceYaw(face: Face): number {
  switch (face.normal) {
    case 'z+':
      return 0;
    case 'z-':
      return Math.PI;
    case 'x+':
      return Math.PI / 2;
    case 'x-':
      return -Math.PI / 2;
  }
}

// ---------------------------------------------------------------------------
// Room decor
// ---------------------------------------------------------------------------

function decorateRoom(
  theme: RoomTheme,
  shell: InteriorShell,
  map: FixedRoomLevelMap,
  res: ResourceBag,
  animators: Animator[],
  labels: LabelFactory,
  textLabels: TextLabel[],
  images: ImageTextureLoader | null,
): void {
  switch (theme.decor) {
    case 'strk20':
      strk20Decor(theme, shell, map);
      return;
    case 'avnu':
      avnuDecor(theme, shell, map, res, animators);
      return;
    case 'degen':
      degenDecor(theme, shell, map, res, animators, labels, textLabels, images);
      return;
    case 'post-office':
      postOfficeDecor(theme, shell, map);
      return;
    case 'bridge':
      bridgeDecor(theme, shell, map, res, animators);
      return;
    case 'vesu':
      vesuDecor(theme, shell, map, res, labels, textLabels);
      return;
    case 'plain':
      return;
  }
}

/** Inset line around the walkable floor, one hair inside the walls. */
function perimeterInlay(shell: InteriorShell, map: FixedRoomLevelMap, inset: number, width: number, paint: Paint, key = 'floor'): void {
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
function stationAnchor(map: FixedRoomLevelMap): number {
  const first = map.stations[0];
  return first ? first.x + first.width / 2 : map.width / 2;
}

function inSpans(wall: InteriorWall, u0: number, u1: number): boolean {
  return wall.spans.some(([a, b]) => u0 >= a - 1e-6 && u1 <= b + 1e-6);
}

/**
 * STRK20: near-black stone, burnt-orange light strips, the vault door as a
 * dark lens ringed in orange (the one nod), and two panels carrying the
 * cream-to-peach heading gradient in place of paintings.
 */
function strk20Decor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomLevelMap): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  const stone = lift(STRK20.raised, 0.13);
  const hair = lift(STRK20.hairline, 0.12);
  for (const wall of Object.values(shell.walls)) {
    for (const [a, b] of wall.spans) {
      wall.bins.add('unlit', faceBox(wall.face, a, 2.05, 0, b, 2.09, 0.03), STRK20.orange);
      wall.bins.add('unlit', faceBox(wall.face, a, 0.16, 0.035, b, 0.185, 0.05), STRK20.orangePressed);
    }
  }
  for (const offset of [-7.7, -5.1, -1.7, 1.7, 5.1, 7.7]) {
    const u = anchor + offset;
    if (!inSpans(north, u - 0.26, u + 0.26)) continue;
    north.bins.add('body', faceBox(nf, u - 0.22, 0, 0, u + 0.22, 1.9, 0.13), stone);
    north.bins.add('body', faceBox(nf, u - 0.26, 1.9, 0, u + 0.26, 2.02, 0.16), hair);
  }
  const vy = 1.2;
  north.bins.add('body', faceDisc(nf, anchor, vy, 0, 0.74, 0.06, 20), lift(STRK20.raised, 0.08));
  north.bins.add('unlit', faceTorus(nf, anchor, vy, 0.075, 0.74, 0.035, { tubularSegments: 28 }), STRK20.orange);
  north.bins.add('body', faceTorus(nf, anchor, vy, 0.09, 0.48, 0.03, { tubularSegments: 20 }), hair);
  north.bins.add('body', faceDisc(nf, anchor, vy, 0.06, 0.15, 0.06, 12), hair);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const u = anchor + Math.cos(angle) * 0.62;
    const v = vy + Math.sin(angle) * 0.62;
    north.bins.add('body', faceBox(nf, u - 0.035, v - 0.035, 0.06, u + 0.035, v + 0.035, 0.09), hair);
  }
  for (const u of [anchor - 3.4, anchor + 3.4]) {
    if (!inSpans(north, u - 0.6, u + 0.6)) continue;
    north.bins.add('body', faceBox(nf, u - 0.56, 0.96, 0, u + 0.56, 1.94, 0.04), lift(STRK20.black, 0.03));
    const [top, mid, bottom] = [1.88, 1.45, 1.02];
    gradientPanel(north, u - 0.5, mid, u + 0.5, top, 0.045, STRK20.blush, STRK20.cream);
    gradientPanel(north, u - 0.5, bottom, u + 0.5, mid, 0.045, STRK20.peach, STRK20.blush);
    north.bins.add('unlit', faceBox(nf, u - 0.5, 0.9, 0.04, u - 0.1, 0.925, 0.05), STRK20.orange);
  }
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [a, b] of wall.spans) {
      const slots = [a + (b - a) * 0.25, a + (b - a) * 0.5, a + (b - a) * 0.75];
      for (const u of slots) {
        wall.bins.add('body', faceBox(wall.face, u - 0.1, 0.4, 0, u + 0.1, 1.86, 0.04), lift(STRK20.black, 0.03));
        wall.bins.add('unlit', faceBox(wall.face, u - 0.025, 0.46, 0.04, u + 0.025, 1.8, 0.05), STRK20.orange);
      }
      for (const u of [(slots[0]! + slots[1]!) / 2, (slots[1]! + slots[2]!) / 2]) {
        wall.bins.add('body', faceBox(wall.face, u - 0.05, 1.45, 0, u + 0.05, 1.68, 0.06), hair);
        wall.bins.add('unlit', faceBox(wall.face, u - 0.08, 1.68, 0.04, u + 0.08, 1.86, 0.18), STRK20.blush);
      }
    }
  }
  // Hairline joints across the walkable floor, and a black runner edged in light.
  const joint = lift(STRK20.hairline, 0.06);
  for (let x = 2; x < map.width - 1; x++) shell.floor.add('floor', flatQuad(x - 0.012, 1, x + 0.012, map.height - 1, 0.003), joint);
  for (let y = 2; y < map.height - 1; y++) shell.floor.add('floor', flatQuad(1, y - 0.012, map.width - 1, y + 0.012, 0.003), joint);
  carpet(shell, map, lift(STRK20.black, 0.03), theme.floorAccent, 'glow');
}

/** A self-lit panel shading from `bottom` at v0 to `top` at v1 (the STRK20 heading gradient). */
function gradientPanel(
  wall: InteriorWall,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  w: number,
  bottom: number,
  top: number,
): void {
  wall.bins.add('unlit', faceQuad(wall.face, u0, v0, u1, v1, w), (_x, y) => mixColor(bottom, top, (y - v0) / (v1 - v0)));
}

/** A runner from the exit to the first station in line with it. */
function carpet(shell: InteriorShell, map: FixedRoomLevelMap, colour: number, edge: number, edgeKey = 'floor'): void {
  const exit = map.exit;
  if (!exit) return;
  const station = map.stations.find((candidate) => candidate.x < exit.x + exit.width && candidate.x + candidate.width > exit.x);
  const zTop = station ? station.y + station.height + 1 : map.height / 2;
  const x0 = exit.x + 0.15;
  const x1 = exit.x + exit.width - 0.15;
  const zBottom = exit.y;
  if (zBottom - zTop < 0.5) return;
  shell.floor.add('floor', flatQuad(x0, zTop, x1, zBottom, 0.004), colour);
  shell.floor.add(edgeKey, flatQuad(x0, zTop, x0 + 0.05, zBottom, 0.007), edge);
  shell.floor.add(edgeKey, flatQuad(x1 - 0.05, zTop, x1, zBottom, 0.007), edge);
}

function pottedPlant(wall: InteriorWall, u: number): void {
  const w = wall.depth * 0.5;
  wall.bins.add('body', faceBox(wall.face, u - 0.18, 0, w - 0.18, u + 0.18, 0.36, w + 0.18), 0x8a5a3a);
  const [x, , z] = faceToWorld(wall.face, u, 0, w);
  wall.bins.add('body', sphereGeometry(x, 0.58, z, 0.2, { widthSegments: 6, heightSegments: 4, scaleY: 1.2 }), PALETTE.hedgeLight);
  wall.bins.add('body', sphereGeometry(x + 0.06, 0.78, z - 0.04, 0.13, { widthSegments: 6, heightSegments: 4 }), PALETTE.hedge);
}

/**
 * avnu: navy and indigo, rounded chart cards and a blue LED ticker along the
 * north wall, which runs on above the trading desk's wall of boards
 * (`tradingDesk`), and chart cards and light strips down the side walls.
 */
function avnuDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomLevelMap, res: ResourceBag, animators: Animator[]): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  const charts: ReadonlyArray<readonly [number, number]> = [
    [anchor - 10.6, anchor - 7.2],
    [anchor - 6.6, anchor - 3.2],
  ];
  charts.forEach(([u0, u1], index) => {
    if (!inSpans(north, u0 - 0.05, u1 + 0.05)) return;
    north.bins.add('unlit', facePanel(nf, u0 - 0.035, 1.02, u1 + 0.035, 2.01, 0.02, 0.17), AVNU.indigoBorder);
    north.bins.add('unlit', facePanel(nf, u0, 1.05, u1, 1.98, 0.03, 0.15), AVNU.card);
    candlesticks(north.bins, nf, u0 + 0.15, u1 - 0.15, 1.1, 1.9, index, { up: AVNU.lightBlue, down: AVNU.slate, line: AVNU.blue });
  });
  addTicker(north, map, res, animators, EXCHANGE_ROOM_TICKER);

  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [s0, s1] of wall.spans) {
      for (let u = s0 + 0.8; u < s1 - 0.4; u += 2.4) {
        wall.bins.add('unlit', faceBox(wall.face, u - 0.018, 0.2, 0.02, u + 0.018, 2.0, 0.04), lift(AVNU.indigoBorder, 0.08));
      }
      const mid = (s0 + s1) / 2;
      for (const u of [mid - 1.4, mid + 1.4]) {
        wall.bins.add('unlit', facePanel(wall.face, u - 0.64, 1.02, u + 0.64, 1.83, 0.02, 0.13), AVNU.indigoBorder);
        wall.bins.add('unlit', facePanel(wall.face, u - 0.6, 1.05, u + 0.6, 1.8, 0.03, 0.12), AVNU.card);
        for (let i = 0; i < 6; i++) {
          const h = 0.1 + hash01(Math.round(u * 10), i, 321) * 0.45;
          const bu = u - 0.46 + i * 0.16;
          wall.bins.add('unlit', facePanel(wall.face, bu, 1.12, bu + 0.1, 1.12 + h, 0.035, 0.03), i % 2 === 0 ? AVNU.blue : AVNU.lightBlue);
        }
      }
      pottedPlant(wall, s1 - 0.6);
    }
  }
  // A faint indigo grid across the walkable floor.
  const glowLine = mixColor(theme.floorA, theme.floorAccent, 0.45);
  for (let x = 2; x < map.width - 1; x++) shell.floor.add('glow', flatQuad(x - 0.012, 1, x + 0.012, map.height - 1, 0.004), glowLine);
  for (let y = 2; y < map.height - 1; y++) shell.floor.add('glow', flatQuad(1, y - 0.012, map.width - 1, y + 0.012, 0.004), glowLine);
}

/**
 * The Degen floor: avnu's navy and indigo, turned up. Neon runs along every
 * wall, DEGEN MODE glows behind the counter over an LED run, and the walls
 * carry a poster per `DEGEN_TOKENS` entry: the project's own art in a neon
 * frame of its colour. Nothing here is a price, a chart or an arrow: the
 * World must not know what money is (AGENTS.md §4).
 */
function degenDecor(
  theme: RoomTheme,
  shell: InteriorShell,
  map: FixedRoomLevelMap,
  res: ResourceBag,
  animators: Animator[],
  labels: LabelFactory,
  textLabels: TextLabel[],
  images: ImageTextureLoader | null,
): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  for (const wall of Object.values(shell.walls)) {
    for (const [a, b] of wall.spans) {
      wall.bins.add('unlit', faceBox(wall.face, a, 0.16, 0.035, b, 0.19, 0.05), DEGEN.pink);
      // The north wall's top carries the LED run instead.
      if (wall !== north) wall.bins.add('unlit', faceBox(wall.face, a, 2.05, 0, b, 2.09, 0.03), DEGEN.cyan);
    }
  }
  // DEGEN MODE behind the counter, in a neon tube frame.
  const [s0, s1, t0, t1] = [anchor - 1.72, anchor + 1.72, 1.24, 1.94];
  if (inSpans(north, s0 - 0.05, s1 + 0.05)) {
    north.bins.add('unlit', facePanel(nf, s0, t0, s1, t1, 0.02, 0.18), DEGEN.pink);
    north.bins.add('unlit', facePanel(nf, s0 + 0.035, t0 + 0.035, s1 - 0.035, t1 - 0.035, 0.024, 0.16), AVNU.navy);
    const sign = labels.sign(DEGEN_SIGN_TEXT, DEGEN_SIGN_STYLE);
    textLabels.push(sign);
    sign.object.position.set(...faceToWorld(nf, anchor, (t0 + t1) / 2, 0.034));
    sign.object.userData['area'] = 'degen-sign';
    north.group.add(sign.object);
  }
  addTicker(north, map, res, animators, DEGEN_ROOM_TICKER);
  DEGEN_TOKENS.slice(0, DEGEN_POSTER_SLOTS.length).forEach((token, index) => {
    const slot = DEGEN_POSTER_SLOTS[index]!;
    degenPoster(shell.walls[slot.wall], slot.u, token, res, labels, textLabels, images);
  });
  // Neon tubes up the side walls, between and beside the posters.
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const u of [2.9, 9.9]) {
      if (!inSpans(wall, u - 0.05, u + 0.05)) continue;
      wall.bins.add('unlit', faceBox(wall.face, u - 0.025, 0.3, 0.02, u + 0.025, 1.95, 0.05), u < 5 ? DEGEN.lime : DEGEN.violet);
    }
  }
  // Underfoot, avnu's grid in pink and cyan, and a pool of pink light at the counter.
  const pink = mixColor(theme.floorA, DEGEN.pink, 0.55);
  const cyan = mixColor(theme.floorA, DEGEN.cyan, 0.45);
  for (let x = 2; x < map.width - 1; x++) shell.floor.add('glow', flatQuad(x - 0.012, 1, x + 0.012, map.height - 1, 0.004), x % 2 ? pink : cyan);
  for (let y = 2; y < map.height - 1; y++) shell.floor.add('glow', flatQuad(1, y - 0.012, map.width - 1, y + 0.012, 0.004), y % 2 ? cyan : pink);
  const station = map.stations[0];
  if (station) {
    const c = new Color(DEGEN.pink);
    const cx = station.x + station.width / 2;
    shell.floor.addRGBA('light', flatQuad(cx - 2.6, station.y - 1, cx + 2.6, station.y + station.height + 2.4, 0.012), (x, _y, z) => {
      const dx = (x - cx) / 2.6;
      const dz = (z - (station.y + station.height)) / 2.4;
      return [c.r, c.g, c.b, 0.16 * clamp01(1 - Math.hypot(dx, dz))];
    });
  }
}

/**
 * One token's poster. A neon frame in the token's accent stands out of the
 * wall round the art: the project's own poster, decoded by `images` and shown
 * once it is ready. Recessed behind it sits the procedural stand-in (colour
 * block, bands, motif), which rides the wall's lights bin at no draw call of
 * its own. The stand-in is what shows while the art loads; it gains its
 * ticker-and-name board only when no art is coming (no loader, or a failed
 * load), so the art and the board never both spend a draw call.
 */
function degenPoster(
  wall: InteriorWall,
  u: number,
  token: DegenToken,
  res: ResourceBag,
  labels: LabelFactory,
  textLabels: TextLabel[],
  images: ImageTextureLoader | null,
): void {
  const f = wall.face;
  const { width, height } = DEGEN_POSTER_SIZE;
  const frame = DEGEN_POSTER_FRAME;
  const [u0, u1, v0, v1] = [u - width / 2, u + width / 2, DEGEN_POSTER_BOTTOM, DEGEN_POSTER_BOTTOM + height];
  if (!inSpans(wall, u0 - frame - 0.05, u1 + frame + 0.05)) return;
  const { background, accent, ink } = token.colors;
  // The frame: four bars out of the wall, their front a lip just proud of the art.
  const [back, front] = [0.02, DEGEN_POSTER_DEPTH + 0.006];
  wall.bins.add('unlit', faceBox(f, u0 - frame, v0 - frame, back, u0, v1 + frame, front), accent);
  wall.bins.add('unlit', faceBox(f, u1, v0 - frame, back, u1 + frame, v1 + frame, front), accent);
  wall.bins.add('unlit', faceBox(f, u0, v1, back, u1, v1 + frame, front), accent);
  wall.bins.add('unlit', faceBox(f, u0, v0 - frame, back, u1, v0, front), accent);
  // The stand-in, behind the art's plane.
  wall.bins.add('unlit', facePanel(f, u0, v0, u1, v1, 0.046, 0.02), background);
  wall.bins.add('unlit', facePanel(f, u0 + 0.1, v1 - 0.14, u1 - 0.1, v1 - 0.1, 0.048, 0.02), accent);
  wall.bins.add('unlit', facePanel(f, u0 + 0.1, v1 - 0.2, u0 + 0.46, v1 - 0.17, 0.048, 0.015), ink);
  degenMotif(wall, token.motif, u, v0 + height * 0.64, accent, ink);

  const board = (): void => {
    const sign = labels.sign(`${token.ticker}\n${token.name}`, degenPosterStyle(token));
    textLabels.push(sign);
    sign.object.position.set(...faceToWorld(f, u, v0 + 0.42, DEGEN_POSTER_DEPTH - 0.004));
    sign.object.rotation.y = faceYaw(f);
    sign.object.userData['token'] = token.ticker;
    wall.group.add(sign.object);
  };
  if (!images) {
    board();
    return;
  }

  const material = res.material(new MeshBasicMaterial({ toneMapped: false }));
  const art = new Mesh(res.geometry(new PlaneGeometry(width, height)), material);
  art.name = `${wall.group.name}:poster:${token.ticker}`;
  art.userData['poster'] = token.ticker;
  art.position.set(...faceToWorld(f, u, v0 + height / 2, DEGEN_POSTER_DEPTH));
  art.rotation.y = faceYaw(f);
  // Hidden until decoded: a map with no image yet samples black.
  art.visible = false;
  wall.group.add(art);
  wall.fadeMaterials.push(material);

  const show = (texture: Texture): void => {
    // The room may be gone by the time the image arrives; nothing may leak.
    if (res.disposed) {
      texture.dispose();
      return;
    }
    res.texture(texture);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    // Read at the camera's pitch, and along the side walls at a slant.
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    material.map = texture;
    material.needsUpdate = true;
    art.visible = true;
  };
  const standIn = (): void => {
    if (res.disposed) return;
    art.removeFromParent();
    board();
  };
  let pending: Promise<Texture>;
  try {
    pending = images.load(token.poster);
  } catch (error) {
    pending = Promise.reject(error);
  }
  pending.then(show, standIn).catch(() => {
    // A late failure (a label factory throwing) must not surface as an
    // unhandled rejection: the procedural poster is already on the wall.
  });
}

/** A stand-in poster's board: the ticker big in the token's ink, its name under it in the accent. */
export function degenPosterStyle(token: DegenToken): SignStyleOptions {
  const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`;
  return {
    width: 0.94,
    height: 0.36,
    background: hex(token.colors.background),
    foreground: hex(token.colors.ink),
    accent: hex(token.colors.accent),
    subtitleColor: hex(token.colors.accent),
    cornerRadius: 0.1,
    borderWidth: 0,
    hairline: false,
    titleFont: 'display',
    titleWeight: 900,
    titleTracking: 0.04,
    subtitleFont: 'mono',
    subtitleTracking: 0.18,
    uppercase: true,
  };
}

/**
 * A stand-in poster's motif, centred on (u, v): simple convex shapes, never a
 * token's mark. Every part stays behind the art's plane (`DEGEN_POSTER_DEPTH`).
 */
function degenMotif(wall: InteriorWall, motif: DegenMotif, u: number, v: number, accent: number, ink: number): void {
  const f = wall.face;
  const [w0, w1] = [0.05, 0.056];
  const shape = (points: readonly (readonly [number, number])[], colour: number): void => {
    wall.bins.add('unlit', facePrism(f, points.map(([du, dv]) => [u + du, v + dv] as const), w0, w1), colour);
  };
  switch (motif) {
    case 'crown':
      shape([[-0.26, -0.2], [0.26, -0.2], [0.26, -0.1], [-0.26, -0.1]], accent);
      for (const [du, height] of [[-0.2, 0.2], [0, 0.26], [0.2, 0.2]] as const) {
        shape([[du - 0.09, -0.1], [du + 0.09, -0.1], [du, -0.1 + height]], accent);
      }
      wall.bins.add('unlit', faceDisc(f, u, v + 0.18, w1, 0.035, 0.012, 8), ink);
      break;
    case 'stars':
      for (const [du, dv, r] of [[-0.16, 0.08, 0.16], [0.14, -0.06, 0.11], [0.2, 0.18, 0.07]] as const) {
        shape([[du, dv - r], [du + r * 0.28, dv], [du, dv + r], [du - r * 0.28, dv]], accent);
        shape([[du - r, dv], [du, dv - r * 0.28], [du + r, dv], [du, dv + r * 0.28]], ink);
      }
      break;
    case 'blade':
      shape([[0, 0.26], [0.055, 0.02], [0, -0.1], [-0.055, 0.02]], ink);
      shape([[-0.17, -0.1], [0.17, -0.1], [0.17, -0.06], [-0.17, -0.06]], accent);
      shape([[-0.03, -0.1], [0.03, -0.1], [0.03, -0.23], [-0.03, -0.23]], accent);
      wall.bins.add('unlit', faceDisc(f, u, v - 0.25, w0, 0.045, 0.014, 8), accent);
      break;
    case 'coin':
      wall.bins.add('unlit', faceDisc(f, u, v, w0, 0.22, 0.014, 20), accent);
      wall.bins.add('unlit', faceTorus(f, u, v, w1 + 0.004, 0.16, 0.014, { tubularSegments: 20 }), ink);
      shape([[-0.035, -0.09], [0.035, -0.09], [0.035, 0.09], [-0.035, 0.09]], ink);
      break;
    case 'gem':
      shape([[-0.2, 0.06], [-0.1, 0.18], [0.1, 0.18], [0.2, 0.06]], accent);
      shape([[-0.2, 0.06], [0.2, 0.06], [0, -0.22]], ink);
      break;
    case 'bolt':
      shape([[0.06, 0.24], [0.14, 0.24], [0.02, 0.0], [-0.08, 0.0]], accent);
      shape([[-0.02, 0.02], [0.08, 0.02], [-0.08, -0.24], [-0.1, -0.24]], accent);
      break;
  }
}

/** A scrolling LED ticker along the top of a wall, fading with that wall. */
function addTicker(
  wall: InteriorWall,
  map: FixedRoomLevelMap,
  res: ResourceBag,
  animators: Animator[],
  segments: readonly TickerSegment[],
): void {
  const [a, b] = wall.spans[0] ?? [INTERIOR_WALL_THICKNESS, map.width - INTERIOR_WALL_THICKNESS];
  const tickerWidth = b - a;
  const tickerHeight = 0.14;
  const strip = createTickerStrip(segments);
  const texture = res.texture(strip.texture);
  texture.repeat.set(tickerWidth / (tickerHeight / strip.height) / strip.width, 1);
  const material = res.material(new MeshBasicMaterial({ map: texture, toneMapped: false }));
  const ticker = new Mesh(res.geometry(new PlaneGeometry(tickerWidth, tickerHeight)), material);
  ticker.name = `${wall.group.name}:ticker`;
  const [tx, ty, tz] = faceToWorld(wall.face, (a + b) / 2, 2.07, 0.012);
  ticker.position.set(tx, ty, tz);
  wall.group.add(ticker);
  wall.fadeMaterials.push(material);
  wall.bins.add('body', faceBox(wall.face, a, 1.98, 0, b, 2.16, 0.01), AVNU.navy);
  animators.push((elapsed) => {
    texture.offset.x = (((elapsed / 1000) * 12) / strip.width) % 1;
  });
}

function candlesticks(
  bins: GeometryBin,
  face: Face,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  seed: number,
  colours: { readonly up: number; readonly down: number; readonly line: number },
): void {
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
    const colour = close >= open ? colours.up : colours.down;
    bins.add('unlit', faceBox(face, u - step * 0.3, y(lo), 0.075, u + step * 0.3, Math.max(y(hi), y(lo) + 0.02), 0.08), colour);
    bins.add('unlit', faceBox(face, u - 0.008, y(Math.max(0, lo - 0.06)), 0.075, u + 0.008, y(Math.min(1, hi + 0.06)), 0.078), colour);
    points.push([u, y(close) + 0.06]);
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const [ua, va] = points[i]!;
    const [ub, vb] = points[i + 1]!;
    bins.add('unlit', beamGeometry(faceToWorld(face, ua, va, 0.085), faceToWorld(face, ub, vb, 0.085), 0.008, 0.018), colours.line);
  }
}

/**
 * Cream and blue: the pigeonholes of the sorting room along the north wall
 * behind the counter (`postOfficeCounter`), a clock and an airmail poster
 * past its end, and shelves of parcels down the side walls, clear of it.
 */
function postOfficeDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomLevelMap): void {
  const north = shell.walls.north;
  const nf = north.face;
  const centre = map.width / 2;
  const station = map.stations[0];
  // The pigeonholes span the counter's sorting room, or the wall's middle without one.
  const [c0, c1, v0, v1] = station ? [station.x - 1.8, station.x + station.width + 3.8, 0.15, 1.95] : [centre - 3, centre + 3, 0.15, 1.95];
  if (inSpans(north, c0, c1)) {
    const depth = 0.32;
    north.bins.add('body', faceBox(nf, c0, v0, 0, c1, v1, depth), 0x8a5a3a);
    const cols = Math.round((c1 - c0) / 0.6);
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
  const clockU = station ? c1 + 1.6 : centre - 5.6;
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
  // Behind and beside the counter the west wall is the sorting room's: its shelves start past the counter.
  const counterEnd = station ? station.y + station.height + 0.4 : 0;
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [s0, s1] of wall.spans) {
      const a = wall === shell.walls.west ? Math.max(s0 + 1.2, counterEnd) : s0 + 1.2;
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

/**
 * NEAR (deposits route through NEAR Intents): black walls and floor, a grey
 * grid of crosshair marks underfoot, and a dashed green route to the desk,
 * which stands in a gateway (`gatewayTerminal`). Along the north wall, a
 * quiet route map in green light runs through that gateway: on a card west
 * of it five chains feed one junction and three solver lanes race, the
 * middle one winning; the single route runs on behind the gateway to
 * Starknet on a card east of it, a pulse travelling along it. The side walls
 * carry cards with crosshair corners (one still pending, in amber) above a
 * run of slashes on the wainscot.
 */
function bridgeDecor(theme: RoomTheme, shell: InteriorShell, map: FixedRoomLevelMap, res: ResourceBag, animators: Animator[]): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  const panel = lift(NEAR.black, 0.04);
  const frame = lift(NEAR.hairline, 0.16);
  const mark = lift(NEAR.muted, 0.08);
  const idle = lift(NEAR.muted, -0.22);

  // The two cards either side of the gateway, the route running between them behind it.
  const [west0, west1, east0, east1, v0, v1] = [anchor - 8.05, anchor - 3.35, anchor + 3.35, anchor + 8.05, 1.04, 2.0];
  if (inSpans(north, west0, east1)) {
    nearCard(north, west0, v0, west1, v1, panel, frame, mark);
    nearCard(north, east0, v0, east1, v1, panel, frame, mark);
    const vc = (v0 + v1) / 2;
    const w = 0.04;
    const [sources, junction, split, merge, destination] = [west0 + 0.55, west0 + 1.95, west0 + 2.45, west1 - 0.5, east1 - 1.4];
    const line = (ua: number, va: number, ub: number, vb: number, colour: number, width: number): void => {
      north.bins.add('unlit', beamGeometry(faceToWorld(nf, ua, va, w), faceToWorld(nf, ub, vb, w), 0.008, width), colour);
    };
    // Five chains feed one junction, bending in at 45 degrees like a transit map.
    [NEAR.muted, NEAR.teal, NEAR.muted, NEAR.periwinkle, NEAR.muted].forEach((colour, i) => {
      const v = vc + (i - 2) * 0.16;
      const bend = junction - Math.abs(v - vc);
      north.bins.add('unlit', faceDisc(nf, sources, v, 0.03, 0.045, 0.016, 10), colour);
      line(sources + 0.05, v, bend, v, theme.floorAccent, 0.014);
      if (bend < junction) line(bend, v, junction, vc, theme.floorAccent, 0.014);
    });
    north.bins.add('unlit', faceTorus(nf, junction, vc, w + 0.004, 0.055, 0.012, { tubularSegments: 16 }), theme.floorAccent);
    // Three solver lanes race from the split to the merge; the middle one wins.
    line(junction + 0.055, vc, destination - 0.11, vc, theme.floorAccent, 0.022);
    for (const dv of [-0.14, 0.14]) {
      line(split, vc, split + 0.14, vc + dv, idle, 0.012);
      line(split + 0.14, vc + dv, merge - 0.14, vc + dv, idle, 0.012);
      line(merge - 0.14, vc + dv, merge, vc, idle, 0.012);
    }
    // Starknet, the one destination: a white core in a green ring, over a
    // faint aurora that shades from green to a hint of violet.
    north.bins.add('unlit', faceTorus(nf, destination, vc, w + 0.004, 0.11, 0.016, { tubularSegments: 20 }), theme.floorAccent);
    north.bins.add('unlit', faceDisc(nf, destination, vc, 0.03, 0.06, 0.018, 12), NEAR.white);
    const glow = new RingGeometry(0, 1, 32, 5);
    const position = glow.getAttribute('position');
    const colours = new Float32Array(position.count * 4);
    const inner = new Color(theme.floorAccent);
    const outer = new Color(NEAR.violet);
    const tint = new Color();
    for (let i = 0; i < position.count; i++) {
      const r = Math.min(1, Math.hypot(position.getX(i), position.getY(i)));
      tint.copy(inner).lerp(outer, clamp01(r * 1.3));
      colours.set([tint.r, tint.g, tint.b, 0.34 * (1 - r) ** 1.7], i * 4);
    }
    glow.setAttribute('color', new BufferAttribute(colours, 4));
    const aurora = new Mesh(res.geometry(glow.scale(0.7, 0.42, 1)), res.material(unlitMaterial({ additive: true })));
    aurora.name = `${north.group.name}:aurora`;
    aurora.renderOrder = 2;
    aurora.position.set(...faceToWorld(nf, destination, vc, 0.032));
    north.group.add(aurora);
    north.fadeMaterials.push(aurora.material);
    // A pulse runs the route from the junction, rests at Starknet, repeats.
    const pulse = new Mesh(
      res.geometry(new CircleGeometry(0.032, 10)),
      res.material(unlitMaterial({ color: NEAR.greenTint, vertexColors: false })),
    );
    pulse.name = `${north.group.name}:pulse`;
    north.group.add(pulse);
    north.fadeMaterials.push(pulse.material);
    // Endpoints once, so the per-frame step allocates nothing.
    const [fromX, fromY, fromZ] = faceToWorld(nf, junction, vc, 0.06);
    const [toX, toY, toZ] = faceToWorld(nf, destination, vc, 0.06);
    const place = (elapsed: number): void => {
      const s = Math.min(1, ((elapsed / 1000) % 3) / 2.4);
      const t = s * s * (3 - 2 * s);
      pulse.position.set(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, fromZ + (toZ - fromZ) * t);
    };
    place(0);
    animators.push(place);
  }

  // The wainscot's run of slashes, on every wall.
  for (const wall of Object.values(shell.walls)) {
    for (const [s0, s1] of wall.spans) {
      for (let u = s0 + 0.3; u + 0.32 < s1; u += 0.24) {
        wall.bins.add('body', beamGeometry(faceToWorld(wall.face, u, 0.6, 0.028), faceToWorld(wall.face, u + 0.12, 0.82, 0.028), 0.01, 0.022), frame);
      }
    }
  }
  // Side-wall cards, one chain each: a ring, and its route's progress bar.
  const cards: ReadonlyArray<readonly [number, number, boolean]> = [
    [NEAR.teal, 1, false],
    [NEAR.muted, 0.55, true],
    [NEAR.periwinkle, 1, false],
    [NEAR.muted, 1, false],
  ];
  let next = 0;
  for (const wall of [shell.walls.west, shell.walls.east]) {
    const [s0, s1] = wall.spans[0] ?? [0, 0];
    const mid = (s0 + s1) / 2;
    for (const u of [mid - 2.1, mid + 2.1]) {
      const [ring, done, pending] = cards[next++ % cards.length]!;
      if (!inSpans(wall, u - 0.72, u + 0.72)) continue;
      nearCard(wall, u - 0.7, 1.12, u + 0.7, 1.78, panel, frame, mark);
      wall.bins.add('unlit', faceTorus(wall.face, u - 0.38, 1.45, 0.044, 0.1, 0.016, { tubularSegments: 16 }), ring);
      wall.bins.add('unlit', faceBox(wall.face, u - 0.16, 1.43, 0.03, u + 0.5, 1.47, 0.036), lift(NEAR.hairline, 0.06));
      wall.bins.add('unlit', faceBox(wall.face, u - 0.16, 1.43, 0.036, u - 0.16 + 0.66 * done, 1.47, 0.042), pending ? NEAR.amber : theme.floorAccent);
    }
  }

  // Underfoot: a grey grid of crosshairs (clear of the desk's halo), and the
  // route from the exit to the desk, dashed in green.
  const station = map.stations[0];
  const exit = map.exit;
  if (!exit) return;
  const routeX = exit.x + exit.width / 2;
  const cross = lift(NEAR.hairline, 0.2);
  for (let x = 2; x < map.width - 1; x += 2) {
    for (let z = 2; z < map.height - 1; z += 2) {
      if (Math.abs(x - routeX) < 0.5) continue;
      if (station && x >= station.x - 1 && x <= station.x + station.width + 1 && z >= station.y - 1 && z <= station.y + station.height + 1) continue;
      if ([[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]].some(([tx, tz]) => map.tiles[tz!]?.[tx!] === 'fixture')) continue;
      shell.floor.add('floor', flatQuad(x - 0.08, z - 0.008, x + 0.08, z + 0.008, 0.004), cross);
      shell.floor.add('floor', flatQuad(x - 0.008, z - 0.08, x + 0.008, z + 0.08, 0.004), cross);
    }
  }
  const zTop = station ? station.y + station.height + 1.12 : map.height / 2;
  for (let z = exit.y - 0.95; z - 0.34 > zTop; z -= 0.56) {
    shell.floor.add('glow', flatQuad(routeX - 0.025, z - 0.34, routeX + 0.025, z, 0.008), theme.floorAccent);
  }
}

/**
 * Vesu (the Vault, opened on shadow accounts, D-077), in its app's light
 * pages and its mark: white walls over a periwinkle wainscot, a white floor
 * laid in large tiles with hairline joints, one electric blue running along
 * the top of every wall. Behind the counter hangs Vesu's avatar, the V
 * glowing on black in its social art's gradients, with a soft light round
 * it; either side, a market board in the app's idiom, white cards listing
 * markets as token discs, name bars and rate bars. The side walls are lined
 * with safe-deposit lockers, `vesu` in the wordmark's wide ink letters above
 * them, and white planters close the ends. Underfoot, a periwinkle runner
 * edged in blue light leads from the exit to the counter over the V inlaid
 * in the floor. Decoration only: no figure, rate, symbol or price anywhere,
 * and nothing live. The World must not know what money is (AGENTS.md §4).
 */
function vesuDecor(
  theme: RoomTheme,
  shell: InteriorShell,
  map: FixedRoomLevelMap,
  res: ResourceBag,
  labels: LabelFactory,
  textLabels: TextLabel[],
): void {
  const north = shell.walls.north;
  const nf = north.face;
  const anchor = stationAnchor(map);
  for (const wall of Object.values(shell.walls)) {
    for (const [a, b] of wall.spans) wall.bins.add('unlit', faceBox(wall.face, a, 2.05, 0, b, 2.09, 0.03), VESU.blue);
  }

  // Vesu's avatar behind the counter: the V glowing on black.
  const [p0, p1, q0, q1] = [anchor - 0.98, anchor + 0.98, 0.3, 2.0];
  if (inSpans(north, p0 - 0.1, p1 + 0.1)) {
    north.bins.add('body', facePanel(nf, p0 - 0.05, q0 - 0.05, p1 + 0.05, q1 + 0.05, 0.012, 0.2), VESU.fill);
    north.bins.add('unlit', facePanel(nf, p0, q0, p1, q1, 0.03, 0.18), VESU.ink);
    addVesuMark(north.bins, 'unlit', nf, anchor, q0 + 0.24, 1.26, 0.04, 0.06, 'dark');
    north.group.add(vesuGlow(north, res, anchor, q0 + 0.86, 0.78, 0.74));
  }

  // The market boards: rows of token discs, name bars and rate bars.
  for (const [u, seed] of [[anchor - 3.35, 1], [anchor + 3.35, 2]] as const) {
    if (!inSpans(north, u - 1.45, u + 1.45)) continue;
    vesuMarketBoard(north, u - 1.3, 0.92, u + 1.3, 1.96, seed);
  }
  // White planters at the north wall's ends, clear of the boards.
  for (const [a, b] of north.spans) {
    vesuPlanter(north, a + 0.55);
    vesuPlanter(north, b - 0.55);
  }

  // Down each side, a bank of safe-deposit lockers under `vesu`.
  for (const wall of [shell.walls.west, shell.walls.east]) {
    for (const [s0, s1] of wall.spans) {
      const mid = (s0 + s1) / 2;
      const [l0, l1] = [mid - 2.4, mid + 1.6];
      if (!inSpans(wall, l0 - 0.1, l1 + 0.1)) continue;
      vesuLockers(wall, l0, l1);
      const sign = labels.sign(VESU_WORDMARK_TEXT, VESU_WALL_WORDMARK);
      textLabels.push(sign);
      sign.object.position.set(...faceToWorld(wall.face, (l0 + l1) / 2, 1.84, 0.05));
      sign.object.rotation.y = faceYaw(wall.face);
      sign.object.userData['area'] = 'vesu-wordmark';
      wall.group.add(sign.object);
      vesuPlanter(wall, s1 - 0.8);
    }
  }

  // Underfoot: hairline joints, the runner edged in blue light, the V inlaid.
  const joint = VESU.fill;
  for (let x = 3; x < map.width - 1; x += 2) shell.floor.add('floor', flatQuad(x - 0.012, 1, x + 0.012, map.height - 1, 0.003), joint);
  for (let y = 3; y < map.height - 1; y += 2) shell.floor.add('floor', flatQuad(1, y - 0.012, map.width - 1, y + 0.012, 0.003), joint);
  carpet(shell, map, VESU.blueSoft, theme.floorAccent, 'glow');
  const exit = map.exit;
  if (exit) {
    const cx = exit.x + exit.width / 2;
    const inlay: Face = { normal: 'z+', plane: 0 };
    // Lying flat, its top towards the counter; a thin geometry on the floor's own glow bin.
    const mark = new GeometryBin();
    try {
      addVesuMark(mark, 'glow', inlay, 0, 0, 1.25, 0, 0.001, 'light');
      const geometry = mark.take('glow');
      if (geometry) {
        geometry.rotateX(-Math.PI / 2).translate(cx, 0.006, exit.y - 1.25);
        shell.floor.add('glow', geometry, (x, _y, z) => vesuMarkColour('light', (x - cx) / 1.25, (exit.y - 1.25 - z) / 1.25));
      }
    } finally {
      mark.dispose();
    }
  }
  // A pool of blue light round each counter.
  const c = new Color(VESU.blue);
  for (const station of map.stations) {
    const scx = station.x + station.width / 2;
    shell.floor.addRGBA('light', flatQuad(scx - 2.4, station.y - 1.6, scx + 2.4, station.y + station.height + 2.2, 0.012), (x, _y, z) => {
      const dx = (x - scx) / 2.4;
      const dz = (z - (station.y + station.height)) / 2.2;
      return [c.r, c.g, c.b, 0.14 * clamp01(1 - Math.hypot(dx, dz))];
    });
  }
}

/** Vesu's wordmark, in lowercase as its logo sets it. */
export const VESU_WORDMARK_TEXT = 'vesu';

/** `vesu` over the lockers: the wordmark's ink letters with no board, widened like Base Neue Wide. */
const VESU_WALL_WORDMARK: SignStyleOptions = Object.freeze({
  width: 2.2,
  height: 0.46,
  background: 'rgba(255,255,255,0)',
  foreground: css(VESU.ink),
  accent: css(VESU.ink),
  cornerRadius: 0,
  borderWidth: 0,
  hairline: false,
  titleFont: 'sans',
  titleWeight: 700,
  titleStretch: 1.4,
  titleTracking: -0.01,
  lowercase: true,
});

/** A Vesu card on a wall: a white self-lit panel on the page grey, 8 px round. */
function vesuCard(wall: InteriorWall, u0: number, v0: number, u1: number, v1: number): void {
  wall.bins.add('unlit', facePanel(wall.face, u0 - 0.03, v0 - 0.03, u1 + 0.03, v1 + 0.03, 0.02, 0.12), VESU.fill);
  wall.bins.add('unlit', facePanel(wall.face, u0, v0, u1, v1, 0.03, 0.1), VESU.white);
}

/**
 * A board in the idiom of Vesu's market list: a title bar and a periwinkle
 * tab, then rows striped in the page grey, each a token disc, a name bar and
 * a rate bar in the blues. Bars and discs only: no figure, no symbol,
 * nothing live. Orange and green stay the V's alone.
 */
function vesuMarketBoard(wall: InteriorWall, u0: number, v0: number, u1: number, v1: number, seed: number): void {
  const f = wall.face;
  vesuCard(wall, u0, v0, u1, v1);
  const pad = 0.12;
  wall.bins.add('unlit', facePanel(f, u0 + pad, v1 - 0.17, u0 + pad + 0.62, v1 - 0.1, 0.034, 0.03), VESU.ink);
  wall.bins.add('unlit', facePanel(f, u1 - pad - 0.44, v1 - 0.19, u1 - pad, v1 - 0.08, 0.034, 0.05), VESU.blueSoft);
  wall.bins.add('unlit', facePanel(f, u1 - pad - 0.38, v1 - 0.155, u1 - pad - 0.06, v1 - 0.115, 0.036, 0.02), VESU.blueText);
  const discs = [0x6d4df2, 0x2775ca, 0x627eea, VESU.muted, VESU.blueText];
  const rows = 4;
  const top = v1 - 0.26;
  const step = (top - (v0 + 0.08)) / rows;
  for (let i = 0; i < rows; i++) {
    const r0 = top - step * (i + 1);
    const r1 = top - step * i;
    const mid = (r0 + r1) / 2;
    if (i % 2 === 0) wall.bins.add('unlit', facePanel(f, u0 + 0.06, r0 + 0.01, u1 - 0.06, r1 - 0.01, 0.032, 0.05), VESU.page);
    wall.bins.add('unlit', faceDisc(f, u0 + pad + 0.06, mid, 0.032, 0.055, 0.004, 12), discs[(i + seed) % discs.length]!);
    wall.bins.add('unlit', facePanel(f, u0 + pad + 0.18, mid - 0.025, u0 + pad + 0.18 + 0.36 + 0.2 * hash01(seed, i, 411), mid + 0.025, 0.034, 0.02), VESU.fill);
    const length = 0.25 + 0.45 * hash01(seed, i, 412);
    wall.bins.add('unlit', facePanel(f, u1 - pad - length, mid - 0.03, u1 - pad, mid + 0.03, 0.034, 0.03), i % 3 === 1 ? VESU.blueText : VESU.blue);
  }
}

/** A bank of safe-deposit lockers on a wall: white doors on a page-grey carcass, a chrome pull each, a few lit blue. */
function vesuLockers(wall: InteriorWall, u0: number, u1: number): void {
  const f = wall.face;
  const [v0, v1] = [0.16, 1.58];
  const depth = 0.26;
  wall.bins.add('body', faceBox(f, u0, v0, 0, u1, v1, depth), VESU.page);
  const cols = Math.max(2, Math.round((u1 - u0) / 0.5));
  const rows = 4;
  const cw = (u1 - u0 - 0.1) / cols;
  const rh = (v1 - v0 - 0.1) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = u0 + 0.05 + c * cw;
      const b = v0 + 0.05 + r * rh;
      wall.bins.add('body', facePanel(f, a + 0.03, b + 0.03, a + cw - 0.03, b + rh - 0.03, depth + 0.004, 0.035), VESU.white);
      wall.bins.add('body', faceBox(f, a + cw - 0.12, b + rh / 2 - 0.015, depth + 0.004, a + cw - 0.07, b + rh / 2 + 0.015, depth + 0.03), 0xc9ccd2);
      if (hash01(r, c, 421) < 0.22) wall.bins.add('unlit', faceDisc(f, a + 0.09, b + rh - 0.09, depth + 0.004, 0.018, 0.006, 8), VESU.blue);
    }
  }
  wall.bins.add('body', faceBox(f, u0 - 0.02, v1, 0, u1 + 0.02, v1 + 0.04, depth + 0.02), VESU.fill);
}

/** A white planter on a wall's decor strip: Vesu's white, with greenery. */
function vesuPlanter(wall: InteriorWall, u: number): void {
  if (!inSpans(wall, u - 0.25, u + 0.25)) return;
  const w = wall.depth * 0.5;
  wall.bins.add('body', faceBox(wall.face, u - 0.2, 0, w - 0.18, u + 0.2, 0.42, w + 0.18), VESU.white);
  wall.bins.add('body', faceBox(wall.face, u - 0.21, 0.4, w - 0.19, u + 0.21, 0.44, w + 0.19), VESU.fill);
  const [x, , z] = faceToWorld(wall.face, u, 0, w);
  wall.bins.add('body', sphereGeometry(x, 0.66, z, 0.22, { widthSegments: 6, heightSegments: 4, scaleY: 1.2 }), PALETTE.hedgeLight);
  wall.bins.add('body', sphereGeometry(x + 0.07, 0.88, z - 0.04, 0.15, { widthSegments: 6, heightSegments: 4 }), PALETTE.hedge);
}

/** A soft glow round the avatar's V: mint at its heart, fading out, additive, fading with its wall. */
function vesuGlow(wall: InteriorWall, res: ResourceBag, u: number, v: number, rx: number, ry: number): Mesh {
  const glow = new RingGeometry(0, 1, 32, 5);
  const position = glow.getAttribute('position');
  const colours = new Float32Array(position.count * 4);
  const inner = new Color(VESU_MARK.dark.triangle[1]![3]!);
  const outer = new Color(VESU.blue);
  const tint = new Color();
  for (let i = 0; i < position.count; i++) {
    const r = Math.min(1, Math.hypot(position.getX(i), position.getY(i)));
    tint.copy(inner).lerp(outer, clamp01(r * 1.2));
    colours.set([tint.r, tint.g, tint.b, 0.3 * (1 - r) ** 1.6], i * 4);
  }
  glow.setAttribute('color', new BufferAttribute(colours, 4));
  const mesh = new Mesh(res.geometry(glow.scale(rx, ry, 1)), res.material(unlitMaterial({ additive: true })));
  mesh.name = `${wall.group.name}:glow`;
  mesh.renderOrder = 2;
  mesh.position.set(...faceToWorld(wall.face, u, v, 0.034));
  mesh.rotation.y = faceYaw(wall.face);
  wall.fadeMaterials.push(mesh.material);
  return mesh;
}

/** A NEAR card on a wall: a black panel in a hairline frame, crosshairs in its corners. */
function nearCard(wall: InteriorWall, u0: number, v0: number, u1: number, v1: number, fill: number, frame: number, mark: number): void {
  const f = wall.face;
  const t = 0.012;
  wall.bins.add('body', faceBox(f, u0, v0, 0, u1, v1, 0.03), fill);
  wall.bins.add('body', faceBox(f, u0, v0, 0.03, u1, v0 + t, 0.034), frame);
  wall.bins.add('body', faceBox(f, u0, v1 - t, 0.03, u1, v1, 0.034), frame);
  wall.bins.add('body', faceBox(f, u0, v0 + t, 0.03, u0 + t, v1 - t, 0.034), frame);
  wall.bins.add('body', faceBox(f, u1 - t, v0 + t, 0.03, u1, v1 - t, 0.034), frame);
  const arm = 0.05;
  const bar = 0.012;
  for (const u of [u0 + 0.1, u1 - 0.1]) {
    for (const v of [v0 + 0.1, v1 - 0.1]) {
      wall.bins.add('body', faceBox(f, u - arm, v - bar / 2, 0.03, u + arm, v + bar / 2, 0.036), mark);
      wall.bins.add('body', faceBox(f, u - bar / 2, v - arm, 0.03, u + bar / 2, v + arm, 0.036), mark);
    }
  }
}
