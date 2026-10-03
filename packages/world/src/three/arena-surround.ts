import { BufferGeometry as BufferGeometryClass, Float32BufferAttribute, Group, Mesh, type BufferGeometry, type Material } from 'three';
import { ARENA_HEIGHT, ARENA_WIDTH } from '@strkworld/shared';
import { createStreetMap } from '../map/street.js';
import { CITY_FRONT, backdropCity } from './backdrop.js';
import { COLOSSEUM_AREA } from '../map/colosseum.js';
import {
  GeometryBin,
  PALETTE,
  ResourceBag,
  flatQuad,
  hash01,
  mixColor,
  shade,
  standardMaterial,
} from './palette.js';
import { MAP_SOUTH_EDGE, createSouthVista, type SouthVista } from './south-vista.js';

/**
 * What a player inside the arena sees over its wall (D-128): the same city
 * the street stands in.
 *
 * The arena is a room, drawn at the interiors' origin over the hidden street
 * (D-039), so until now there was nothing outside its arcade but fog —
 * "floating in blank white nothingness". This module puts the World back
 * round it, and does it by mounting the street's own scenery modules rather
 * than copying them: `backdropCity` from three/backdrop.ts to the north and
 * D-124's `createSouthVista` to the south, in the arena room's own group, so
 * whatever those modules become the arena follows along. The sky is already
 * the engine's one dome (three/sky.ts), and the fog is the engine's, so the
 * city hazes out at exactly the distance the street's does.
 *
 * Where it stands. The arena is about three times the Colosseum's footprint
 * on the street — a room always is bigger than its building — so there is no
 * one offset that puts the scenery right on every side. Each side is lined up
 * with the wall it stands behind instead, the way a theatre's backdrop is
 * hung: the city's front (`CITY_FRONT`) sits `CITY_GAP` north of the arena's
 * north wall, and the river's near shore (`MAP_SOUTH_EDGE`) sits `VISTA_GAP`
 * south of its south wall. Along x both are centred on the building's own
 * centre, so the street's buildings stand where they would be seen from the
 * arena's middle.
 *
 * The city is clipped to what belongs north of the arena: the backdrop's plan
 * also lays fields and hedgerows west, east and south of the district, and at
 * this offset those would stand inside the stadium.
 *
 * Draw calls: the city and its lit windows (two), plus the vista's own five
 * or six. On the low-detail path the vista is left out altogether — the camera
 * always looks north (D-059), so nothing south of the arena is ever in frame.
 * The ground under all of it costs nothing: `layArenaOutsideGround` lays it
 * into the room's own floor bin.
 */

/** How far north of the arena's wall the city's front row stands. */
export const CITY_GAP = 16;
/** How far south of the arena's wall the river's near shore lies. */
export const VISTA_GAP = 2;

/**
 * Arena-local x of the Colosseum's centre on the street: both backdrops are
 * slid along x by this, so the city is seen from the stadium's own middle.
 */
const CITY_DX = ARENA_WIDTH / 2 - (COLOSSEUM_AREA.x + COLOSSEUM_AREA.width / 2);
const CITY_DZ = -CITY_GAP - CITY_FRONT;
const VISTA_DZ = ARENA_HEIGHT + VISTA_GAP - MAP_SOUTH_EDGE;

/** Nothing of the city may cross this arena-local row: it would stand in the stadium. */
const CITY_CLIP_Z = -CITY_GAP + 0.5;

/** The ground lies a hair under the arena's own floor, so nothing z-fights with it. */
const GROUND_Y = -0.08;
/** How far the ground runs: past the fog on every side, from the arena's middle. */
const GROUND_REACH = 180;

export interface ArenaSurroundOptions {
  /**
   * Phones and other coarse-pointer screens: the river, the station and the
   * city across the water are left out. They are south of the arena, and the
   * camera never looks south.
   */
  readonly lowDetail?: boolean;
  /** Sampled once at build, as the street's vista is: the water holds still. */
  readonly reducedMotion?: boolean;
}

export interface ArenaSurround {
  /** Add to the arena room's group: everything in it is arena-local. */
  readonly group: Group;
  update(elapsedMs: number): void;
  dispose(): void;
}

/**
 * The lawn, the road and the fields the city stands on, in arena-local
 * coordinates, laid into a bin the room already flushes (its floor): a few
 * flat bands, so the ground beyond the wall costs no draw call of its own.
 */
export function layArenaOutsideGround(bin: GeometryBin, key: string): void {
  const cx = ARENA_WIDTH / 2;
  const cz = ARENA_HEIGHT / 2;
  const x0 = cx - GROUND_REACH;
  const x1 = cx + GROUND_REACH;
  const band = (z0: number, z1: number, colour: number, seed: number): void => {
    bin.add(key, flatQuad(x0, cz + z0, x1, cz + z1, GROUND_Y), (px: number, _py: number, pz: number) =>
      shade(colour, (hash01(Math.round(px / 8), Math.round(pz / 8), seed) - 0.5) * 0.05),
    );
  };
  // From the far fields in the north, past the city, to the water in the south.
  band(-GROUND_REACH, -90, mixColor(PALETTE.grassCool, PALETTE.grassWarm, 0.3).getHex(), 61);
  band(-90, -40, PALETTE.grassCool, 62);
  band(-40, -cz - CITY_GAP, PALETTE.apron, 63);
  band(-cz - CITY_GAP, GROUND_REACH, PALETTE.grassWarm, 64);
  // The street in front of the city: two pavements and a carriageway, as the
  // district's own road is, so the city has something to stand along.
  const road = (z0: number, z1: number, colour: number): void => {
    bin.add(key, flatQuad(x0, cz + z0, x1, cz + z1, GROUND_Y + 0.01), colour);
  };
  const front = -cz - CITY_GAP + 3;
  road(front, front + 1, PALETTE.sidewalk);
  road(front + 1, front + 5, PALETTE.asphalt);
  road(front + 5, front + 6, PALETTE.sidewalk);
}

/** Build the city (and, off the low-detail path, the water) round the arena. */
export function createArenaSurround(options: ArenaSurroundOptions = {}): ArenaSurround {
  const res = new ResourceBag();
  const group = new Group();
  group.name = 'arena:outside';
  let vista: SouthVista | null = null;

  const bin = new GeometryBin();
  try {
    const city = new Group();
    city.name = 'arena:outside-north';
    city.position.set(CITY_DX, 0, CITY_DZ);
    group.add(city);
    // The street's own backdrop, built in street coordinates inside a group
    // that slides it behind the arena's north wall.
    backdropCity(createStreetMap(), bin);
    const limit = CITY_CLIP_Z - CITY_DZ;
    flushClipped(bin, 'far', res.material(standardMaterial({ roughness: 0.95 })), res, city, 'arena:outside-city', limit);
    flushClipped(
      bin,
      'far-lit',
      res.material(standardMaterial({ roughness: 0.6, emissive: PALETTE.backdropWindow, emissiveIntensity: 0.9 })),
      res,
      city,
      'arena:outside-windows',
      limit,
    );

    if (options.lowDetail !== true) {
      vista = createSouthVista({ reducedMotion: options.reducedMotion === true });
      vista.group.position.set(CITY_DX, 0, VISTA_DZ);
      group.add(vista.group);
    }
  } catch (error) {
    try {
      vista?.dispose();
    } catch {
      // The construction error stays authoritative.
    }
    res.dispose();
    group.clear();
    throw error;
  } finally {
    bin.dispose();
  }

  let disposed = false;
  return {
    group,
    update(elapsedMs) {
      if (disposed) return;
      vista?.update(Number.isFinite(elapsedMs) ? elapsedMs : 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        vista?.dispose();
      } finally {
        vista = null;
        group.removeFromParent();
        group.clear();
        res.dispose();
      }
    },
  };
}

/**
 * Flush one key of the bin, keeping only the triangles that stay north of
 * `limit` (in the key's own coordinates): the backdrop's plan also lays
 * fields and hedgerows west, east and south of the district, and at this
 * offset those would stand inside the stadium.
 */
function flushClipped(
  bin: GeometryBin,
  key: string,
  material: Material,
  res: ResourceBag,
  parent: Group,
  name: string,
  limit: number,
): void {
  const geometry = bin.take(key);
  if (!geometry) return;
  const kept = keepTriangles(geometry, limit);
  geometry.dispose();
  if (!kept) return;
  const mesh = new Mesh(res.geometry(kept), material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
}

/**
 * A copy of `geometry` holding only the triangles whose every vertex is at or
 * north of `limit`. The bin's geometry is always non-indexed with a colour per
 * vertex, so a triangle is three consecutive vertices.
 */
function keepTriangles(geometry: BufferGeometry, limit: number): BufferGeometry | null {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const colour = geometry.getAttribute('color');
  const keep: number[] = [];
  for (let t = 0; t + 2 < position.count; t += 3) {
    if (Math.max(position.getZ(t), position.getZ(t + 1), position.getZ(t + 2)) > limit) continue;
    keep.push(t, t + 1, t + 2);
  }
  if (keep.length === 0) return null;
  const out = new BufferGeometryClass();
  const slice = (source: { getComponent(index: number, component: number): number }, size: number): number[] => {
    const data: number[] = [];
    for (const index of keep) for (let c = 0; c < size; c++) data.push(source.getComponent(index, c));
    return data;
  };
  out.setAttribute('position', new Float32BufferAttribute(slice(position, 3), 3));
  if (normal) out.setAttribute('normal', new Float32BufferAttribute(slice(normal, 3), 3));
  if (colour) out.setAttribute('color', new Float32BufferAttribute(slice(colour, colour.itemSize), colour.itemSize));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
