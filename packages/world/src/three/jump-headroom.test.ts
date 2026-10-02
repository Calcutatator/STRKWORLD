import { describe, expect, it } from 'vitest';
import { Group, InstancedMesh, Matrix4, Mesh, Vector3, type Object3D } from 'three';
import { PLAYER_BODY_SIZE } from '@strkworld/shared';
import { AVATAR_STUDIO_DEFINITION, isAvatarStudioSolidAt } from '../avatar-studio.js';
import {
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_ROOF_LEVEL,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  isFixedRoomSolidAt,
  type FixedRoomLevelMap,
} from '../fixed-room.js';
import { JUMP_HEIGHT } from '../jump.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { AVATAR_FIGURE_HEIGHT } from './avatar-figure.js';
import { createNullLabelFactory } from './labels.js';
import { boxGeometry } from './palette.js';
import { buildFixedRoom } from './room-builder.js';
import { buildAvatarStudio } from './studio-builder.js';
import type { AvatarFigureFactory } from './types.js';

/**
 * Headroom for the jump indoors (D-111). The rooms have no ceilings: their
 * walls stop at 2.2 and the camera looks in over them, so a jump never meets
 * a ceiling and the camera never clips one. But the room rule (D-059) lets
 * dressing hang over the walkable floor from 1.9 up, and at the apex the top
 * of the tallest look reaches `AVATAR_FIGURE_HEIGHT + JUMP_HEIGHT` (2.95).
 * This pins exactly which dressing a jumping head can pass through, so a new
 * lamp, tray or sign in that band is a decision, not an accident. Each entry
 * below was looked at and accepted: the head shows through it for the hang
 * at the top of the arc (about a third of the air time), and nothing is
 * hidden or blocked by it.
 */

const OX = ROOM_ORIGIN.x / FIXED_ROOM_TILE_SIZE;
const OZ = ROOM_ORIGIN.y / FIXED_ROOM_TILE_SIZE;
/** The band a jumping head sweeps that standing never does. */
const BAND = Object.freeze({ min: 1.9, max: AVATAR_FIGURE_HEIGHT + JUMP_HEIGHT });
/** The body's half-width, in tiles: how close to a solid tile its centre comes. */
const HALF = PLAYER_BODY_SIZE / FIXED_ROOM_TILE_SIZE / 2;
/** Generous head (and hat, and hair) radius about the body's centre line. */
const HEAD = 0.3;

const ACCEPTED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Endur's booth canopy (D-104) overhangs its approach at 2.26.
  'bank ground': ['room:bank:counters'],
  'bridge ground': [],
  'exchange ground': [],
  'post-office ground': [],
  // The cable trays over both corridors (2.27–2.36), the loops sagging off
  // them to 2.0, the cut cable (1.93), the hanging ceiling tile and the
  // flickering tube (2.1): the abandoned net cafe's whole overhead (D-107).
  'bunker ground': ['room:bunker:floor', 'room:bunker:floor-glow', 'room:bunker:tube'],
  'vault ground': [],
  'exchange degen': [],
  'exchange roof': [],
  // The exit's surround and its lights in the north wall (2.02–2.05), reached
  // only by a jump right at the threshold.
  studio: ['avatar-studio:wall-north:body', 'avatar-studio:wall-north:lights'],
});

/** Whether a head could be at (x, z): some body centre within `HEAD` of it stands on walkable floor whole. */
function reachable(walkable: (x: number, z: number) => boolean, x: number, z: number): boolean {
  const step = HEAD / 3;
  for (let dx = -HEAD; dx <= HEAD + 1e-9; dx += step) {
    for (let dz = -HEAD; dz <= HEAD + 1e-9; dz += step) {
      if (dx * dx + dz * dz > HEAD * HEAD + 1e-9) continue;
      let whole = true;
      for (const ox of [-HALF, 0, HALF]) {
        for (const oz of [-HALF, 0, HALF]) {
          if (!walkable(x + dx + ox, z + dz + oz)) whole = false;
        }
      }
      if (whole) return true;
    }
  }
  return false;
}

/** Names of the meshes with any surface inside the band over a reachable head position. */
function inJumpColumn(root: Object3D, walkable: (x: number, z: number) => boolean): string[] {
  // Answers on a 0.05 grid, remembered: the samples are dense, the floor small.
  const cache = new Map<number, boolean>();
  const near = (x: number, z: number): boolean => {
    const gx = Math.round(x / 0.05);
    const gz = Math.round(z / 0.05);
    const key = gx * 100_000 + gz;
    let answer = cache.get(key);
    if (answer === undefined) {
      answer = reachable(walkable, gx * 0.05, gz * 0.05);
      cache.set(key, answer);
    }
    return answer;
  };
  root.updateMatrixWorld(true);
  const found = new Set<string>();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const p = new Vector3();
  const instance = new Matrix4();
  const world = new Matrix4();
  root.traverse((object) => {
    if (!(object instanceof Mesh) || found.has(object.name)) return;
    // D-123: an affordance shell is a light drawn over its counter's own
    // pieces, not furniture; the counter itself is checked.
    if (object.userData['affordance']) return;
    const position = object.geometry.getAttribute('position');
    const index = object.geometry.getIndex();
    const triangles = (index ? index.count : position.count) / 3;
    const instances = object instanceof InstancedMesh ? object.count : 1;
    for (let n = 0; n < instances; n++) {
      if (object instanceof InstancedMesh) {
        object.getMatrixAt(n, instance);
        world.multiplyMatrices(object.matrixWorld, instance);
      } else {
        world.copy(object.matrixWorld);
      }
      for (let t = 0; t < triangles; t++) {
        a.fromBufferAttribute(position, index ? index.getX(t * 3) : t * 3).applyMatrix4(world);
        b.fromBufferAttribute(position, index ? index.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(world);
        c.fromBufferAttribute(position, index ? index.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(world);
        if (Math.max(a.y, b.y, c.y) < BAND.min || Math.min(a.y, b.y, c.y) > BAND.max) continue;
        const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
        const steps = Math.max(1, Math.ceil(edge / 0.1));
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps - i; j++) {
            const u = i / steps;
            const v = j / steps;
            const w = 1 - u - v;
            p.set(a.x * w + b.x * u + c.x * v, a.y * w + b.y * u + c.y * v, a.z * w + b.z * u + c.z * v);
            if (p.y < BAND.min || p.y > BAND.max) continue;
            if (near(p.x, p.z)) {
              found.add(object.name);
              return;
            }
          }
        }
      }
    }
  });
  return [...found].sort();
}

/**
 * The arena (D-114) is left out: its tiers are walkable surfaces at a height,
 * so its band moves with the floor under the head; arena-room.test.ts checks
 * its headroom from each tile's own surface.
 */
const FLOORS: readonly FixedRoomLevelMap[] = [
  ...fixedRoomDefinitionsFor({ vaultOpen: true }).filter((definition) => definition.building !== 'arena').map(createFixedRoom),
  createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL),
  createFixedRoomLevel(EXCHANGE_ROOF_LEVEL),
];

describe('headroom for the jump indoors (D-111)', () => {
  it('reaches 2.95 at the apex for the tallest look', () => {
    expect(BAND.max).toBeCloseTo(2.95, 5);
  });

  it('catches a lamp hung in the band over the floor, and not one hung above it', () => {
    const map = FLOORS.find((floor) => floor.building === 'bridge')!;
    const walkable = (x: number, z: number) =>
      x >= OX && z >= OZ && x < OX + map.width && z < OZ + map.height &&
      !isFixedRoomSolidAt(map, Math.floor(x - OX), Math.floor(z - OZ));
    const open = { x: 0, y: 0 };
    for (let y = 1; y < map.height - 1 && !open.x; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        if (!isFixedRoomSolidAt(map, x, y)) {
          open.x = x;
          open.y = y;
          break;
        }
      }
    }
    const lamp = (y: number) => {
      const root = new Group();
      const mesh = new Mesh(boxGeometry(OX + open.x + 0.4, y, OZ + open.y + 0.4, OX + open.x + 0.6, y + 0.1, OZ + open.y + 0.6));
      mesh.name = 'lamp';
      root.add(mesh);
      return root;
    };
    expect(inJumpColumn(lamp(2.4), walkable)).toEqual(['lamp']);
    expect(inJumpColumn(lamp(3.1), walkable)).toEqual([]);
  });

  it('lists every interior floor and the Studio', () => {
    expect(Object.keys(ACCEPTED).sort()).toEqual([...FLOORS.map((map) => `${map.building} ${map.level}`), 'studio'].sort());
  });

  it.each(FLOORS.map((map) => ({ key: `${map.building} ${map.level}`, map })))(
    'passes a jumping head through only the accepted dressing in $key',
    ({ key, map }) => {
      const room = buildFixedRoom(map, createNullLabelFactory());
      const walkable = (x: number, z: number) =>
        x >= OX && z >= OZ && x < OX + map.width && z < OZ + map.height &&
        !isFixedRoomSolidAt(map, Math.floor(x - OX), Math.floor(z - OZ));
      expect(inJumpColumn(room.group, walkable)).toEqual([...ACCEPTED[key]!].sort());
      room.dispose();
    },
  );

  it('passes a jumping head through only the accepted dressing in the Studio', () => {
    const figures: AvatarFigureFactory = (key) => ({
      object: new Group(),
      look: key,
      setLook() {},
      update() {},
      dispose() {},
    });
    const studio = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, figures, createNullLabelFactory());
    const d = AVATAR_STUDIO_DEFINITION;
    const walkable = (x: number, z: number) =>
      x >= OX && z >= OZ && x < OX + d.width && z < OZ + d.height &&
      !isAvatarStudioSolidAt(d, Math.floor(x - OX), Math.floor(z - OZ));
    expect(inJumpColumn(studio.group, walkable)).toEqual([...ACCEPTED['studio']!].sort());
    studio.dispose();
  });
});
