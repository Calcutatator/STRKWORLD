import { describe, expect, it, vi } from 'vitest';
import {
  Box3,
  BufferGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Texture,
  Vector3,
} from 'three';
import {
  FIXED_ROOM_DEFINITIONS,
  createFixedRoom,
  fixedRoomStationPresentations,
  isFixedRoomSolidAt,
  type FixedRoomMap,
  type FixedRoomState,
} from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { createNullLabelFactory } from './labels.js';
import {
  INTERIOR_SOUTH_WALL_HEIGHT,
  INTERIOR_WALL_HEIGHT,
  buildFixedRoom,
  type InteriorOccluder,
} from './room-builder.js';
import type { LabelFactory, RoomView } from './types.js';

const DEFINITIONS = Object.values(FIXED_ROOM_DEFINITIONS);
const OX = ROOM_ORIGIN.x / 32;
const OZ = ROOM_ORIGIN.y / 32;

function build(building: keyof typeof FIXED_ROOM_DEFINITIONS, labels: LabelFactory = createNullLabelFactory()) {
  const map = createFixedRoom(FIXED_ROOM_DEFINITIONS[building]);
  return { map, room: buildFixedRoom(map, labels) };
}

function roomState(
  map: FixedRoomMap,
  status: 'available' | 'locked',
  highlightedStation: FixedRoomState['highlightedStation'],
  label?: string,
): FixedRoomState {
  return {
    inRoom: true,
    building: map.building,
    controlOwner: 'world',
    highlightedStation,
    stations: map.stations.map((station) => ({
      station: station.station,
      label: label ?? station.label,
      status,
    })),
  };
}

function stationGroup(room: RoomView, station: string): Object3D {
  const group = room.group.children.find((child) => child.userData['station'] === station);
  if (!group) throw new Error(`no station ${station}`);
  return group;
}

function meshNamed(root: Object3D, suffix: string): Mesh {
  let found: Mesh | undefined;
  root.traverse((object) => {
    if (!found && object instanceof Mesh && object.name.endsWith(suffix)) found = object;
  });
  if (!found) throw new Error(`no mesh ${suffix}`);
  return found;
}

function floatingLabel(root: Object3D): Object3D {
  let found: Object3D | undefined;
  root.traverse((object) => {
    if (!found && object.userData['kind'] === 'floating') found = object;
  });
  if (!found) throw new Error('no floating label');
  return found;
}

describe('buildFixedRoom', () => {
  it.each(DEFINITIONS)('builds the $building interior over its tile grid at the room origin', (definition) => {
    const map = createFixedRoom(definition);
    const room = buildFixedRoom(map, createNullLabelFactory());
    expect(room.building).toBe(definition.building);
    expect(room.group.position.toArray()).toEqual([OX, 0, OZ]);
    room.group.updateMatrixWorld(true);
    const floor = new Box3().setFromObject(meshNamed(room.group, ':floor'));
    expect(floor.min.x).toBeCloseTo(OX);
    expect(floor.max.x).toBeCloseTo(OX + map.width);
    expect(floor.min.z).toBeCloseTo(OZ);
    // The grid, plus a doorstep just outside the south exit.
    expect(floor.max.z).toBeGreaterThanOrEqual(OZ + map.height);
    expect(floor.max.z).toBeLessThanOrEqual(OZ + map.height + 1);
    room.dispose();
  });

  it.each(DEFINITIONS)('gives $building one kiosk, label and halo per station', (definition) => {
    const map = createFixedRoom(definition);
    const room = buildFixedRoom(map, createNullLabelFactory());
    const stations = room.group.children.filter((child) => child.name.startsWith('station:'));
    expect(stations).toHaveLength(map.stations.length);
    room.group.updateMatrixWorld(true);
    for (const station of map.stations) {
      const group = stationGroup(room, station.station);
      expect(group.userData['status']).toBe('locked');
      expect(group.userData['highlighted']).toBe(false);
      const label = floatingLabel(group);
      expect(label.userData['text']).toBe(station.label);
      const position = label.getWorldPosition(new Vector3());
      expect(position.x).toBeCloseTo(OX + station.x + station.width / 2);
      expect(position.z).toBeCloseTo(OZ + station.y + station.height / 2);
      expect(position.y).toBeGreaterThan(1.2);
      const halo = new Box3().setFromObject(meshNamed(group, ':halo'));
      expect(halo.min.x).toBeCloseTo(OX + station.x - 1, 1);
      expect(halo.max.x).toBeCloseTo(OX + station.x + station.width + 1, 1);
      expect(halo.min.z).toBeCloseTo(OZ + station.y - 1, 1);
      expect(halo.max.z).toBeCloseTo(OZ + station.y + station.height + 1, 1);
      expect(halo.max.y).toBeLessThan(0.05);
    }
    room.dispose();
  });

  it('drives status, highlight and label text from station presentations', () => {
    const { map, room } = build('bank');
    const group = stationGroup(room, 'bank:shielding');
    const accent = meshNamed(group, ':status').material as MeshStandardMaterial;
    const halo = meshNamed(group, ':halo').material as MeshBasicMaterial;
    const label = floatingLabel(group);
    const locked = { colour: accent.color.getHex(), halo: halo.opacity };
    expect(accent.emissiveIntensity).toBe(0);

    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null)));
    expect(group.userData['status']).toBe('available');
    expect(group.userData['highlighted']).toBe(false);
    expect(accent.color.getHex()).not.toBe(locked.colour);
    expect(accent.emissiveIntensity).toBeGreaterThan(0);
    expect(halo.opacity).toBeGreaterThan(locked.halo);
    const available = { intensity: accent.emissiveIntensity, halo: halo.opacity };

    room.setStations(
      fixedRoomStationPresentations(map, roomState(map, 'available', 'bank:shielding', 'SHIELD NOW')),
    );
    expect(group.userData['highlighted']).toBe(true);
    expect(accent.emissiveIntensity).toBeGreaterThan(available.intensity);
    expect(halo.opacity).toBeGreaterThan(available.halo);
    expect(label.userData['text']).toBe('SHIELD NOW');

    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'locked', null)));
    expect(group.userData['status']).toBe('locked');
    expect(accent.color.getHex()).toBe(locked.colour);
    expect(accent.emissiveIntensity).toBe(0);
    expect(halo.opacity).toBeCloseTo(locked.halo);
    expect(label.userData['text']).toBe(map.stations[0]!.label);

    // Unknown stations and malformed input have no effect.
    room.setStations([{ ...map.stations[0]!, station: 'bank:other', label: 'X', status: 'available', highlighted: true }]);
    room.setStations(null as never);
    expect(group.userData['status']).toBe('locked');
    room.dispose();
  });

  it('redraws a station label only when its text changes', () => {
    const base = createNullLabelFactory();
    const setText = vi.fn();
    const labels: LabelFactory = {
      sign: base.sign,
      floating(text, options) {
        const label = base.floating(text, options);
        return {
          object: label.object,
          dispose: () => label.dispose(),
          setText(next) {
            setText(next);
            label.setText(next);
          },
        };
      },
    };
    const { map, room } = build('exchange', labels);
    const presentations = fixedRoomStationPresentations(map, roomState(map, 'available', 'exchange:swap'));
    room.setStations(presentations);
    room.setStations(presentations);
    expect(setText).not.toHaveBeenCalled();
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null, 'SWAP 2')));
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'locked', null, 'SWAP 2')));
    expect(setText.mock.calls).toEqual([['SWAP 2']]);
    room.dispose();
  });

  it.each(DEFINITIONS)('keeps the $building south wall low and the other walls tall', (definition) => {
    const map = createFixedRoom(definition);
    const room = buildFixedRoom(map, createNullLabelFactory());
    room.group.updateMatrixWorld(true);
    const southEdge = OZ + map.height - 1 + 0.01;
    const vertex = new Vector3();
    let tallest = -Infinity;
    room.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const position = object.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        if (vertex.z > southEdge) tallest = Math.max(tallest, vertex.y);
      }
    });
    expect(tallest).toBeLessThanOrEqual(0.55);
    const south = new Box3().setFromObject(meshNamed(room.group, ':south-wall'));
    expect(south.max.y).toBeLessThanOrEqual(INTERIOR_SOUTH_WALL_HEIGHT + 0.12);
    const occluders = room.occluders as readonly InteriorOccluder[];
    expect(occluders.map((occluder) => occluder.side).sort()).toEqual(['east', 'north', 'west']);
    for (const occluder of occluders) expect(occluder.bounds.height).toBeGreaterThanOrEqual(INTERIOR_WALL_HEIGHT);
    room.dispose();
  });

  it('puts wall occluders on the wall tiles and fades each wall alone', () => {
    const { map, room } = build('post-office');
    const occluders = room.occluders as readonly InteriorOccluder[];
    const side = (name: string) => occluders.find((occluder) => occluder.side === name)!;
    expect(side('north').bounds).toMatchObject({ minX: OX, maxX: OX + map.width, minZ: OZ, maxZ: OZ + 1 });
    expect(side('west').bounds).toMatchObject({ minX: OX, maxX: OX + 1, minZ: OZ, maxZ: OZ + map.height - 1 });
    expect(side('east').bounds).toMatchObject({
      minX: OX + map.width - 1,
      maxX: OX + map.width,
      minZ: OZ,
      maxZ: OZ + map.height - 1,
    });
    const north = materialsOf(side('north').object);
    const west = materialsOf(side('west').object);
    side('north').setOpacity(0.25);
    for (const material of north) {
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeCloseTo(0.25);
    }
    for (const material of west) expect(material.transparent).toBe(false);
    side('north').setOpacity(1);
    for (const material of north) {
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }
    room.dispose();
  });

  it.each(DEFINITIONS)('keeps every $building volume off the walkable floor', (definition) => {
    const map = createFixedRoom(definition);
    const room = buildFixedRoom(map, createNullLabelFactory());
    const walkable = (x: number, z: number) =>
      !isFixedRoomSolidAt(map, Math.floor(x - OX), Math.floor(z - OZ));
    expect(findWalkableIntrusions(room.group, walkable, { x: OX, z: OZ, width: map.width, height: map.height })).toEqual([]);
    room.dispose();
  });

  it('copies its origin so later mutation cannot move the room', () => {
    const origin = { x: 64, y: 96 };
    const room = buildFixedRoom(createFixedRoom(FIXED_ROOM_DEFINITIONS.bridge), createNullLabelFactory(), origin);
    origin.x = 0;
    expect(room.group.position.x).toBe(2);
    expect(room.group.position.z).toBe(3);
    expect(room.occluders[0]!.bounds.minX).toBe(2);
    room.dispose();
  });

  it('animates deterministically', () => {
    const first = build('bridge').room;
    const second = build('bridge').room;
    for (const room of [first, second]) {
      room.setStations(fixedRoomStationPresentations(createFixedRoom(FIXED_ROOM_DEFINITIONS.bridge), roomState(createFixedRoom(FIXED_ROOM_DEFINITIONS.bridge), 'available', 'bridge:deposit')));
    }
    const sample = (room: RoomView) => {
      const values: number[] = [];
      room.group.traverse((object) => {
        if (object instanceof Mesh) values.push(object.rotation.y, object.rotation.z, object.position.y);
        if (object instanceof Mesh && object.material instanceof MeshBasicMaterial) values.push(object.material.opacity);
      });
      return values;
    };
    const before = sample(first);
    for (const delta of [16, 40, 500, 16]) {
      first.update(delta);
      second.update(delta);
    }
    expect(sample(first)).toEqual(sample(second));
    expect(sample(first)).not.toEqual(before);
    first.dispose();
    second.dispose();
  });

  it('disposes every resource once and ignores calls afterwards', () => {
    const { map, room } = build('exchange');
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    room.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      materials.add(object.material as Material);
      for (const value of Object.values(object.material as object)) if (value instanceof Texture) textures.add(value);
    });
    expect(textures.size).toBeGreaterThan(0);
    const label = floatingLabel(room.group);
    const spies = [...geometries, ...materials, ...textures].map((value) => vi.spyOn(value, 'dispose'));
    const parent = new Object3D();
    parent.add(room.group);
    room.dispose();
    room.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
    expect(label.userData['disposed']).toBe(true);
    room.update(16);
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null)));
  });
});

function materialsOf(root: Object3D): Material[] {
  const found = new Set<Material>();
  root.traverse((object) => {
    if (object instanceof Mesh) found.add(object.material as Material);
  });
  return [...found];
}

/** See street-builder.test.ts: samples below head height inside walkable tiles. */
function findWalkableIntrusions(
  root: Object3D,
  walkable: (x: number, z: number) => boolean,
  area: { x: number; z: number; width: number; height: number },
): string[] {
  const MIN_Y = 0.15;
  const MAX_Y = 1.9;
  const EPS = 0.04;
  const STEP = 0.1;
  root.updateMatrixWorld(true);
  const found: string[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const p = new Vector3();
  const instance = new Matrix4();
  const world = new Matrix4();
  root.traverse((object) => {
    if (!(object instanceof Mesh) || found.length > 20) return;
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
        if (Math.max(a.y, b.y, c.y) < MIN_Y || Math.min(a.y, b.y, c.y) > MAX_Y) continue;
        if (Math.max(a.x, b.x, c.x) < area.x || Math.min(a.x, b.x, c.x) > area.x + area.width) continue;
        if (Math.max(a.z, b.z, c.z) < area.z || Math.min(a.z, b.z, c.z) > area.z + area.height) continue;
        const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
        const steps = Math.max(1, Math.ceil(edge / STEP));
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps - i; j++) {
            const u = i / steps;
            const v = j / steps;
            const w = 1 - u - v;
            p.set(a.x * w + b.x * u + c.x * v, a.y * w + b.y * u + c.y * v, a.z * w + b.z * u + c.z * v);
            if (p.y < MIN_Y || p.y > MAX_Y) continue;
            if (
              walkable(p.x - EPS, p.z - EPS) &&
              walkable(p.x + EPS, p.z - EPS) &&
              walkable(p.x - EPS, p.z + EPS) &&
              walkable(p.x + EPS, p.z + EPS)
            ) {
              found.push(`${object.name} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
              return;
            }
          }
        }
      }
    }
  });
  return found;
}
