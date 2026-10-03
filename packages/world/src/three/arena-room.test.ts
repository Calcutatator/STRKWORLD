import { describe, expect, it, vi } from 'vitest';
import { Box3, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3, type Material, type Object3D } from 'three';
import {
  ARENA_BOX,
  ARENA_DUMMY_TILE,
  ARENA_DUMMY_YAW,
  ARENA_HEIGHT,
  ARENA_RING_FENCE,
  ARENA_RING_GATE,
  ARENA_STAIRS,
  ARENA_TUNNEL,
  ARENA_SWING_MS,
  ARENA_WIDTH,
  arenaTierAt,
  arenaTileAt,
  isArenaFloorKind,
  type AvatarSpriteKey,
} from '@strkworld/shared';
import { ARENA_ROOM_DEFINITION, createFixedRoom, fixedRoomStationPresentations } from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import {
  ARENA_FADE_ROW,
  ARENA_FADE_WEST,
  ARENA_GATE_LAMP,
  ARENA_SURFACE,
  arenaSurfaceHeightAt,
  arenaTorchOpacity,
  buildArenaRoom,
  torchTiles,
  type ArenaRoomView,
} from './arena-room.js';
import { createNullLabelFactory } from './labels.js';
import { createPresenter, roomSurfaceHeightAt } from './presenter.js';
import { ARENA_SEAT_IDLE_MS, attackPoseAt } from '../arena-swing.js';
import { buildFixedRoom } from './room-builder.js';
import type { AvatarFigure, AvatarFigureFactory, LabelFactory } from './types.js';

/**
 * The arena in 3D (D-114): one builder for the whole stadium, its draw-call
 * budget, one bench per seat tile, the tiers' walking heights, headroom over
 * every walkable tile measured from that tile's own surface, the near stands
 * fading as an occluder, the gate and its lamp, and the presenter standing
 * feet (local and remote) and the camera on the tiers.
 */

const OX = ROOM_ORIGIN.x / 32;
const OZ = ROOM_ORIGIN.y / 32;
const map = createFixedRoom(ARENA_ROOM_DEFINITION);

function build(
  options: { readonly reducedMotion?: () => boolean; readonly labels?: LabelFactory; readonly lowDetail?: boolean } = {},
): ArenaRoomView {
  return buildArenaRoom(map, options.labels ?? createNullLabelFactory(), ROOM_ORIGIN, {
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
    ...(options.lowDetail === true ? { lowDetail: true } : {}),
  });
}

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}

function named(root: Object3D, name: string): Mesh {
  const mesh = root.getObjectByName(name);
  if (!(mesh instanceof Mesh)) throw new Error(`no mesh ${name}`);
  return mesh;
}

function tiles(test: (x: number, y: number) => boolean): Array<{ x: number; y: number }> {
  const found: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < ARENA_HEIGHT; y++) for (let x = 0; x < ARENA_WIDTH; x++) if (test(x, y)) found.push({ x, y });
  return found;
}

/** Is `object` part of the surround — the city hung round the stadium (D-129)? */
function outsideSurround(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.name === 'arena:outside') return true;
  }
  return false;
}

/**
 * Points of any mesh that stand on a walkable arena tile higher than a hair
 * above that tile's own surface and below head height over it: the tiers'
 * version of the rooms' "nothing on the walkable floor" rule.
 */
function headroomIntrusions(root: Object3D): string[] {
  root.updateMatrixWorld(true);
  const EPS = 0.04;
  const walkable = (x: number, z: number): number | null => {
    const tx = Math.floor(x - OX);
    const tz = Math.floor(z - OZ);
    return isArenaFloorKind(arenaTileAt(tx, tz)) ? arenaSurfaceHeightAt(tx, tz) : null;
  };
  const found = new Set<string>();
  const details: string[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const p = new Vector3();
  const instance = new Matrix4();
  const world = new Matrix4();
  root.traverse((object) => {
    if (!(object instanceof Mesh) || found.has(object.name)) return;
    // D-129: the city round the stadium stands tens of tiles beyond the
    // walls, nowhere near a walkable tile, and sweeping its thousands of
    // triangles here would cost minutes. The test below holds it clear of the
    // stadium by its bounding box instead.
    if (outsideSurround(object)) return;
    const position = object.geometry.getAttribute('position');
    const index = object.geometry.getIndex();
    const triangles = (index ? index.count : position.count) / 3;
    const instances = object instanceof InstancedMesh ? object.count : 1;
    for (let n = 0; n < instances && !found.has(object.name); n++) {
      if (object instanceof InstancedMesh) {
        object.getMatrixAt(n, instance);
        world.multiplyMatrices(object.matrixWorld, instance);
      } else {
        world.copy(object.matrixWorld);
      }
      for (let t = 0; t < triangles && !found.has(object.name); t++) {
        a.fromBufferAttribute(position, index ? index.getX(t * 3) : t * 3).applyMatrix4(world);
        b.fromBufferAttribute(position, index ? index.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(world);
        c.fromBufferAttribute(position, index ? index.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(world);
        // Nothing can intrude below the sand or above head height on the top tier.
        if (Math.max(a.y, b.y, c.y) <= 0.15 || Math.min(a.y, b.y, c.y) >= ARENA_SURFACE.tier1 + ARENA_SURFACE.tierStep * 4 + 1.9) continue;
        const steps = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / 0.12));
        for (let i = 0; i <= steps && !found.has(object.name); i++) {
          for (let j = 0; j <= steps - i; j++) {
            const u = i / steps;
            const v = j / steps;
            p.set(a.x * (1 - u - v) + b.x * u + c.x * v, a.y * (1 - u - v) + b.y * u + c.y * v, a.z * (1 - u - v) + b.z * u + c.z * v);
            const corners = [walkable(p.x - EPS, p.z - EPS), walkable(p.x + EPS, p.z - EPS), walkable(p.x - EPS, p.z + EPS), walkable(p.x + EPS, p.z + EPS)];
            if (corners.some((height) => height === null)) continue;
            const surface = Math.max(...(corners as number[]));
            if (p.y > surface + 0.15 && p.y < surface + 1.9) {
              found.add(object.name);
              details.push(`${object.name} at (${(p.x - OX).toFixed(2)}, ${p.y.toFixed(2)}, ${(p.z - OZ).toFixed(2)})`);
              break;
            }
          }
        }
      }
    }
  });
  return details.sort();
}

describe('the arena in 3D (D-114)', () => {
  it('is built by its own builder through buildFixedRoom, at the interiors\' origin', () => {
    const room = buildFixedRoom(map, createNullLabelFactory()) as ArenaRoomView;
    expect(room.building).toBe('arena');
    expect(room.group.name).toBe('room:arena');
    expect(room.group.position.x).toBe(OX);
    expect(room.group.position.z).toBe(OZ);
    expect(room.fxMount.parent).toBe(room.group);
    expect(typeof room.setGate).toBe('function');
    room.dispose();
  });

  it('stays within its draw-call budget: 24 or fewer, the rooms\' limit is 40', () => {
    const labels: Object3D[] = [];
    const counting: LabelFactory = {
      sign: (text) => {
        const object = new Group();
        object.userData['text'] = text;
        labels.push(object);
        return { object, setText: () => {}, dispose: () => {} };
      },
      floating: (text) => {
        const object = new Group();
        object.userData['text'] = text;
        labels.push(object);
        return { object, setText: () => {}, dispose: () => {} };
      },
    };
    const room = build({ labels: counting });
    const names = meshes(room.group).map((mesh) => mesh.name).sort();
    expect(names).toEqual([
      // D-123: the emperor's box's shimmer and glow, one additive call.
      'arena:affordances',
      'arena:banners',
      'arena:dummy-body',
      'arena:fence',
      'arena:flames',
      'arena:gate',
      'arena:gate-lamp',
      // D-129: the city round the stadium, the street's own backdrop module.
      'arena:outside-city',
      'arena:outside-windows',
      'arena:sand',
      'arena:seats',
      'arena:stone',
      'arena:stone-south',
      // D-129: D-124's river, station and far city, mounted behind the south
      // wall. Left out of the low-detail path below.
      'south-vista:banks',
      'south-vista:city',
      'south-vista:ferries',
      'south-vista:glass',
      'south-vista:station',
      'south-vista:water',
    ]);
    // The ring's sign and the emperor's box label.
    expect(labels.map((label) => label.userData['text'])).toEqual(['THE RING', "EMPEROR'S BOX\nCLOSED"]);
    const calls = names.length + labels.length;
    expect(calls).toBe(21);
    expect(calls).toBeLessThanOrEqual(24);
    room.dispose();
  });

  it('drops the water south of it on the low-detail path: the camera never looks south (D-129)', () => {
    const full = meshes(build().group).map((mesh) => mesh.name).sort();
    const low = build({ lowDetail: true });
    const names = meshes(low.group).map((mesh) => mesh.name).sort();
    // The stadium and the city north of it are unchanged; only D-124's vista goes.
    expect(names).toEqual(full.filter((name) => !name.startsWith('south-vista:')));
    expect(names).toContain('arena:outside-city');
    expect(names).toHaveLength(13);
    low.dispose();
  });

  it('stands the city clear of the stadium, beyond its walls on both sides (D-129)', () => {
    const room = build();
    const surround = room.group.getObjectByName('arena:outside');
    expect(surround).toBeDefined();
    // The stadium's own tiles, in arena-local coordinates: nothing of the
    // surround may stand inside them, or the city would be in the sand.
    for (const child of surround!.children) {
      const box = new Box3().setFromObject(child);
      const northOfIt = box.max.z - OZ < 0;
      const southOfIt = box.min.z - OZ > ARENA_HEIGHT;
      expect(northOfIt || southOfIt, child.name).toBe(true);
    }
    // And it reaches past the fog on both sides, so there is no visible edge.
    const whole = new Box3().setFromObject(surround!);
    expect(whole.min.z - OZ).toBeLessThan(-40);
    expect(whole.max.z - OZ).toBeGreaterThan(ARENA_HEIGHT + 40);
    room.dispose();
  });

  it('lays one wooden bench on every seat tile, in one draw call', () => {
    const room = build();
    const seats = named(room.group, 'arena:seats');
    expect(seats).toBeInstanceOf(InstancedMesh);
    const tierTiles = tiles((x, y) => arenaTileAt(x, y) === 'tier');
    expect(tierTiles).toHaveLength(447);
    expect((seats as InstancedMesh).count).toBe(447);
    // Each bench sits on its own tile at that tier's height.
    const matrix = new Matrix4();
    const position = new Vector3();
    const seen = new Set<string>();
    for (let n = 0; n < (seats as InstancedMesh).count; n++) {
      (seats as InstancedMesh).getMatrixAt(n, matrix);
      position.setFromMatrixPosition(matrix);
      const x = Math.floor(position.x);
      const y = Math.floor(position.z);
      expect(arenaTileAt(x, y)).toBe('tier');
      expect(position.y).toBeCloseTo(arenaSurfaceHeightAt(x, y));
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBe(447);
    room.dispose();
  });

  it('stands feet on sand, stairs and five tiers at the design\'s heights', () => {
    expect(arenaSurfaceHeightAt(20, 16)).toBe(0);
    // The west tunnel is sand-level all the way out to the street.
    expect(arenaSurfaceHeightAt(2, 16)).toBe(0);
    expect(arenaSurfaceHeightAt(ARENA_STAIRS[0]!.x, 16)).toBe(ARENA_SURFACE.stair);
    expect(ARENA_SURFACE.stair).toBe(0.4);
    const byTier = new Map<number, Set<number>>();
    for (const { x, y } of tiles((x, y) => arenaTileAt(x, y) === 'tier')) {
      const tier = arenaTierAt(x, y);
      const set = byTier.get(tier) ?? new Set();
      set.add(Number(arenaSurfaceHeightAt(x, y).toFixed(4)));
      byTier.set(tier, set);
    }
    expect([...byTier.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([1, 2, 3, 4, 5].map((tier) => [...byTier.get(tier)!])).toEqual([[0.8], [1.25], [1.7], [2.15], [2.6]]);
    // The podium's top is a parapet in front of tier 1, and the arcade stands behind tier 5.
    expect(ARENA_SURFACE.podium).toBe(1.0);
    expect(arenaSurfaceHeightAt(20, 31)).toBe(ARENA_SURFACE.arcade);
    // Every step a walker can take between walkable tiles is a stair's or a tier's, never a climb.
    for (const { x, y } of tiles((x, y) => isArenaFloorKind(arenaTileAt(x, y)))) {
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (!isArenaFloorKind(arenaTileAt(x + dx, y + dy))) continue;
        expect(Math.abs(arenaSurfaceHeightAt(x, y) - arenaSurfaceHeightAt(x + dx, y + dy)), `${x},${y}`).toBeLessThanOrEqual(0.45 + 1e-9);
      }
    }
  });

  it('keeps every volume out of the way over a walkable tile, measured from that tile\'s own surface', () => {
    const room = build();
    expect(headroomIntrusions(room.group)).toEqual([]);
    // Shut, the gate's leaves stand on its own tiles; open, they swing into the ring.
    room.setGate('busy');
    for (let k = 0; k < 20; k++) room.update(100);
    expect(headroomIntrusions(room.group)).toEqual([]);
    room.dispose();
  }, 30_000);

  it('fades the near stands and the west tunnel\'s south side alone as an occluder, so they never hide the player', () => {
    const room = build();
    expect(room.occluders).toHaveLength(1);
    const occluder = room.occluders[0]!;
    // South of the ring's fence: the camera always looks north, so these are the near stands.
    expect(ARENA_FADE_ROW).toBe(ARENA_RING_FENCE.y + ARENA_RING_FENCE.height);
    // Three boxes: the near stands, the tunnel's south side, and its mouth arch.
    expect(occluder.boxes).toHaveLength(3);
    expect(ARENA_FADE_WEST).toEqual({ maxX: ARENA_TUNNEL.x + ARENA_TUNNEL.width, minY: ARENA_TUNNEL.y + ARENA_TUNNEL.height });
    expect(occluder.bounds.minZ).toBe(OZ + ARENA_TUNNEL.y);
    expect(occluder.bounds.maxZ).toBe(OZ + ARENA_HEIGHT);
    expect(occluder.bounds.height).toBeGreaterThan(ARENA_SURFACE.arcade);
    // Every box is inside the whole occluder's bounds.
    for (const box of occluder.boxes!) {
      expect(box.minX).toBeGreaterThanOrEqual(occluder.bounds.minX);
      expect(box.maxX).toBeLessThanOrEqual(occluder.bounds.maxX);
      expect(box.minZ).toBeGreaterThanOrEqual(occluder.bounds.minZ);
      expect(box.maxZ).toBeLessThanOrEqual(occluder.bounds.maxZ);
    }
    const south = named(room.group, 'arena:stone-south');
    const own = [south.material].flat() as Material[];
    const others = meshes(room.group)
      .filter((mesh) => mesh !== south)
      .flatMap((mesh) => [mesh.material].flat() as Material[])
      .filter((material) => !own.includes(material));
    const before = others.map((material) => material.opacity);
    occluder.setOpacity(0.25);
    for (const material of own) expect(material.opacity).toBeCloseTo(0.25);
    expect(others.map((material) => material.opacity)).toEqual(before);
    occluder.setOpacity(1);
    for (const material of own) expect(material.opacity).toBe(1);
    // Everything in the fading mesh is either south of the fade row or in the
    // west tunnel's own strip; nothing else of the stadium fades.
    const fading = south.geometry.getAttribute('position');
    for (let i = 0; i < fading.count; i++) {
      const x = fading.getX(i);
      const z = fading.getZ(i);
      expect(z >= ARENA_FADE_ROW - 0.05 || x <= ARENA_FADE_WEST.maxX + 0.05, `${x},${z}`).toBe(true);
    }
    // The emperor's box is back on the north podium, so it is in the far mesh,
    // which the camera never looks through.
    expect(ARENA_BOX.y).toBeLessThan(ARENA_FADE_ROW);
    const north = named(room.group, 'arena:stone');
    north.geometry.computeBoundingBox();
    expect(north.geometry.boundingBox!.max.z).toBeLessThanOrEqual(ARENA_FADE_ROW + 0.05);
    room.dispose();
  });

  it('closes the west tunnel with the doorway out, facing back down it, and keeps it off the exit tiles', () => {
    const room = build();
    const stone = named(room.group, 'arena:stone');
    const position = stone.geometry.getAttribute('position');
    // Stone stands west of the arena's edge, across the tunnel's end to the street.
    let wall = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      if (x < ARENA_TUNNEL.x && z >= ARENA_TUNNEL.y - 1 && z <= ARENA_TUNNEL.y + ARENA_TUNNEL.height + 1) wall += 1;
      // Nothing of it stands any further out than the wall itself.
      expect(x).toBeGreaterThan(ARENA_TUNNEL.x - 0.5);
    }
    expect(wall).toBeGreaterThan(0);
    room.dispose();
  });

  it('swings the gate open while the ring is free and shut while it is held, with the lamp green or red', () => {
    const room = build();
    const gate = named(room.group, 'arena:gate') as InstancedMesh;
    const lamp = named(room.group, 'arena:gate-lamp').material as MeshBasicMaterial;
    expect(gate.count).toBe(2);
    expect(gate.userData['open']).toBe(1);
    // Open, both leaves swing in, into the ring east of the gate.
    for (let n = 0; n < 2; n++) {
      const m = new Matrix4();
      const q = new Quaternion();
      gate.getMatrixAt(n, m);
      m.decompose(new Vector3(), q, new Vector3());
      expect(new Vector3(1, 0, 0).applyQuaternion(q).x).toBeGreaterThan(0.99);
    }
    expect(ARENA_RING_GATE.x).toBe(ARENA_RING_FENCE.x);
    expect(lamp.color.getHex()).toBe(ARENA_GATE_LAMP.open);
    room.setGate('busy');
    expect(lamp.color.getHex()).toBe(ARENA_GATE_LAMP.busy);
    room.update(100);
    expect(gate.userData['open']).toBeGreaterThan(0);
    expect(gate.userData['open']).toBeLessThan(1);
    for (let k = 0; k < 10; k++) room.update(100);
    expect(gate.userData['open']).toBe(0);
    // Shut, the two leaves meet across the gate's opening.
    const matrix = new Matrix4();
    const rotation = new Quaternion();
    const along = new Vector3();
    for (let n = 0; n < 2; n++) {
      gate.getMatrixAt(n, matrix);
      matrix.decompose(new Vector3(), rotation, new Vector3());
      along.set(1, 0, 0).applyQuaternion(rotation);
      expect(Math.abs(along.x)).toBeLessThan(1e-6);
    }
    room.setGate('open');
    expect(lamp.color.getHex()).toBe(ARENA_GATE_LAMP.open);
    room.dispose();
    // Under reduced motion the gate cuts.
    const reduced = build({ reducedMotion: () => true });
    reduced.setGate('busy');
    reduced.update(16);
    expect((named(reduced.group, 'arena:gate') as InstancedMesh).userData['open']).toBe(0);
    reduced.dispose();
  });

  it('sets the training dummy at its tile, pivoting at the post\'s foot, beside the fx mount', () => {
    const room = build();
    expect(room.dummy.name).toBe('arena:dummy');
    expect(room.dummy.position.x).toBe(ARENA_DUMMY_TILE.x + 0.5);
    expect(room.dummy.position.z).toBe(ARENA_DUMMY_TILE.y + 0.5);
    expect(room.dummy.position.y).toBe(0);
    // Facing south, to the camera, as it always stood; the yaw goes first, so
    // the fx's topple about local z falls east, away from the west gate.
    expect(room.dummy.rotation.y).toBe(ARENA_DUMMY_YAW);
    expect(ARENA_DUMMY_YAW).toBe(0);
    expect(room.dummy.rotation.order).toBe('YXZ');
    room.dummy.rotation.z = -Math.PI / 2;
    room.dummy.updateMatrixWorld(true);
    const head = new Vector3(0, 1, 0).applyQuaternion(room.dummy.quaternion);
    expect(head.x).toBeGreaterThan(0.99);
    room.dummy.rotation.z = 0;
    const body = named(room.dummy, 'arena:dummy-body');
    body.geometry.computeBoundingBox();
    const box = body.geometry.boundingBox!;
    expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(box.max.y).toBeGreaterThan(1.5);
    expect(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z)).toBeLessThan(0.8);
    room.dispose();
  });

  it('lights sixteen braziers round the podium that flicker and never go out', () => {
    const torches = torchTiles();
    expect(torches).toHaveLength(16);
    for (const tile of torches) expect(arenaTileAt(tile.x, tile.y)).toBe('podium');
    expect(new Set(torches.map((tile) => `${tile.x},${tile.y}`)).size).toBe(16);
    const room = build();
    const flames = named(room.group, 'arena:flames') as InstancedMesh;
    expect(flames.count).toBe(16);
    const material = flames.material as MeshBasicMaterial;
    const seen: number[] = [];
    for (let k = 0; k < 60; k++) {
      room.update(50);
      seen.push(material.opacity);
    }
    expect(Math.min(...seen)).toBeGreaterThan(0.55);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.1);
    for (let t = 0; t < 60; t += 0.01) expect(arenaTorchOpacity(t)).toBeGreaterThan(0.6);
    room.dispose();
  });

  it('labels the emperor\'s box from the station state, which never opens it', () => {
    const setText = vi.fn();
    const labels: LabelFactory = {
      sign: () => ({ object: new Group(), setText: () => {}, dispose: () => {} }),
      floating: () => ({ object: new Group(), setText, dispose: () => {} }),
    };
    const room = build({ labels });
    const state = {
      inRoom: true,
      building: 'arena' as const,
      controlOwner: 'world' as const,
      highlightedStation: 'arena:box' as const,
      stations: [{ station: 'arena:box' as const, label: "EMPEROR'S BOX\nCLOSED", status: 'locked' as const }],
    };
    room.setStations(fixedRoomStationPresentations(map, state));
    expect(setText).not.toHaveBeenCalled();
    // A Shell that renamed it only relabels it; the room never opens anything.
    room.setStations(fixedRoomStationPresentations(map, { ...state, stations: [{ ...state.stations[0]!, label: 'CLOSED' }] }));
    expect(setText).toHaveBeenCalledWith('CLOSED');
    room.dispose();
  });
});

function fakeFigures() {
  const created: Array<AvatarFigure & { update: ReturnType<typeof vi.fn> }> = [];
  const factory: AvatarFigureFactory = (key) => {
    let look: AvatarSpriteKey = key;
    const figure = {
      object: new Group(),
      get look() {
        return look;
      },
      setLook: vi.fn((next: AvatarSpriteKey) => {
        look = next;
      }),
      update: vi.fn(),
      dispose: vi.fn(),
    };
    created.push(figure);
    return figure;
  };
  return { factory, created };
}

describe('the presenter in the arena (D-114)', () => {
  const setup = () => {
    const parent = new Group();
    const figures = fakeFigures();
    const presenter = createPresenter({ parent, labels: createNullLabelFactory(), figures: figures.factory });
    const view = presenter.bindSession();
    const avatar = figures.created.find((figure) => figure.object.parent?.name === 'strkworld')!;
    view.setStreetVisible(false);
    view.showRoom('arena');
    return { parent, presenter, view, avatar };
  };
  const roomTile = (x: number, y: number) => ({ x: ROOM_ORIGIN.x + x * 32 + 16, y: ROOM_ORIGIN.y + y * 32 + 16 });

  it('builds the arena the first time it is shown, with the combat fx mounted and the ring\'s gate state applied', () => {
    const parent = new Group();
    const presenter = createPresenter({ parent, labels: createNullLabelFactory(), figures: fakeFigures().factory });
    const view = presenter.bindSession();
    expect(parent.getObjectByName('room:arena')).toBeUndefined();
    view.syncArena({ phase: 'countdown', gate: 'busy', dummy: null, challengerId: null, challengerSwings: 0, selfIsChallenger: false, challengerGuarding: false, challengerBlocks: 0, championId: null, throneId: null, selfIsChampion: false, selfOnThrone: false });
    view.setStreetVisible(false);
    view.showRoom('arena');
    const room = parent.getObjectByName('room:arena')!;
    expect(room.visible).toBe(true);
    expect(room.getObjectByName('arena-fx')?.parent?.name).toBe('arena:fx-mount');
    const lamp = (room.getObjectByName('arena:gate-lamp') as Mesh).material as MeshBasicMaterial;
    expect(lamp.color.getHex()).toBe(ARENA_GATE_LAMP.busy);
    // The gate's mesh, for the gate station's press-E cues (D-117).
    expect((view.arenaGateObject() as Mesh).name).toBe('arena:gate');
    view.showRoom(null);
    expect(room.visible).toBe(false);
    view.showRoom('arena');
    expect(parent.getObjectByName('strkworld')!.children.filter((child) => child.name === 'room:arena')).toHaveLength(1);
    presenter.dispose();
  });

  it('reads the arena\'s surface heights inside it and flat floors in every other room', () => {
    expect(roomSurfaceHeightAt('arena', OX + 3.5, OZ + 16.5)).toBe(arenaSurfaceHeightAt(3, 16));
    expect(roomSurfaceHeightAt('arena', OX + ARENA_STAIRS[0]!.x + 0.5, OZ + 16.5)).toBe(0.4);
    expect(roomSurfaceHeightAt('bunker', OX + 3.5, OZ + 16.5)).toBe(0);
    expect(roomSurfaceHeightAt(null, OX + 3.5, OZ + 16.5)).toBe(0);
  });

  it('stands the local avatar on a tier, easing up the steps, and the camera follows its feet', () => {
    const world = setup();
    world.view.setPlayerPosition(roomTile(20, 22), true);
    world.presenter.update(16);
    world.presenter.consumeSnap();
    expect(world.avatar.object.position.y).toBe(0);
    // Up the east stair onto tier 1: the feet ease (no pop), then settle.
    world.view.setPlayerPosition(roomTile(ARENA_STAIRS[0]!.x, 16), false);
    world.presenter.update(16);
    expect(world.avatar.object.position.y).toBeGreaterThan(0);
    expect(world.avatar.object.position.y).toBeLessThan(0.4);
    for (let k = 0; k < 20; k++) world.presenter.update(16);
    expect(world.avatar.object.position.y).toBeCloseTo(0.4, 3);
    world.view.setPlayerPosition(roomTile(35, 16), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.y).toBeCloseTo(arenaSurfaceHeightAt(35, 16));
    expect(world.presenter.player.elevation).toBeCloseTo(arenaSurfaceHeightAt(35, 16));
  });

  it('sits the local avatar down after standing still on a tier, and swings on cue', () => {
    const world = setup();
    world.view.setPlayerPosition(roomTile(35, 16), true);
    for (let t = 0; t < ARENA_SEAT_IDLE_MS + 100; t += 50) world.presenter.update(50);
    expect(world.avatar.update.mock.calls.at(-1)![1]).toMatchObject({ seated: true });
    world.view.setPlayerMotion({ vx: 100, vy: 0, sprinting: false });
    world.presenter.update(16);
    expect(world.avatar.update.mock.calls.at(-1)![1]).toMatchObject({ seated: false });
    world.view.setPlayerMotion({ vx: 0, vy: 0, sprinting: false });
    world.view.playerSwing();
    world.presenter.update(50);
    expect(world.avatar.update.mock.calls.at(-1)![1].attack).toEqual({ stage: 'windup', progress: 0.5 });
    for (let t = 0; t < ARENA_SWING_MS; t += 50) world.presenter.update(50);
    expect(world.avatar.update.mock.calls.at(-1)![1].attack).toBeNull();
  });

  it('holds the battle stance while the local player fights, and turns to a leap\'s facing', () => {
    const world = setup();
    world.view.setPlayerPosition(roomTile(20, 18), true);
    world.view.syncArena({ phase: 'fighting', gate: 'busy', dummy: { hp: 70, maxHp: 100, hits: 3, down: false }, challengerId: 'p1' as never, challengerSwings: 4, selfIsChallenger: true, challengerGuarding: false, challengerBlocks: 0, championId: null, throneId: null, selfIsChampion: false, selfOnThrone: false });
    world.presenter.update(16);
    expect(world.avatar.update.mock.calls.at(-1)![1]).toMatchObject({ guard: true });
    world.view.setPlayerFacing('up');
    expect(world.avatar.object.rotation.y).toBeCloseTo(Math.PI);
    world.view.syncArena(null);
    world.presenter.update(16);
    expect(world.avatar.update.mock.calls.at(-1)![1]).toMatchObject({ guard: false });
  });

  it('shows the arena prompt over the local avatar and hides it again', () => {
    const world = setup();
    world.view.setArenaPrompt('E · ENTER THE RING');
    const prompt = world.avatar.object.children.find((child) => child.userData['arena'] === 'prompt')!;
    expect(prompt.visible).toBe(true);
    world.view.setArenaPrompt(null);
    expect(prompt.visible).toBe(false);
  });

  it('times a swing in three stages over ARENA_SWING_MS', () => {
    expect(attackPoseAt(0)).toEqual({ stage: 'windup', progress: 0 });
    expect(attackPoseAt(150)).toEqual({ stage: 'strike', progress: 50 / 120 });
    expect(attackPoseAt(285)).toEqual({ stage: 'recover', progress: 0.5 });
    expect(attackPoseAt(ARENA_SWING_MS)).toBeNull();
    expect(attackPoseAt(-1)).toBeNull();
  });
});
