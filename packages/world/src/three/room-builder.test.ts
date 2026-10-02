import { describe, expect, it, vi } from 'vitest';
import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import {
  BANK_ROOM_DEFINITION,
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_DEGEN_STATION,
  FIXED_ROOM_DEFINITIONS,
  VAULT_BORROW_STATION,
  VAULT_REDEEM_STATION,
  VAULT_REPAY_STATION,
  VAULT_ROOM_DEFINITION,
  VAULT_SUPPLY_STATION,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  fixedRoomStationPresentations,
  isFixedRoomSolidAt,
  type FixedRoomLevelMap,
  type FixedRoomState,
} from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { createNullLabelFactory } from './labels.js';
import {
  DEFAULT_ROOM_THEME,
  AVNU,
  AVNU_COUNTER_HEADER,
  DEGEN,
  DEGEN_COUNTER_HEADER,
  DEGEN_STATION_LOOKS,
  DEGEN_TOKENS,
  ENDUR,
  ENDUR_STATION_LOOKS,
  NEAR,
  NEAR_DEPARTURE_HEADER,
  POST_OFFICE_SEND_SIGN,
  POST_OFFICE_SEND_TEXT,
  POST_OFFICE_WINDOW_SIGN,
  ROOM_THEMES,
  STRK20,
  STRK20_STATION_LOOKS,
  VESU,
  VESU_BORROW_STATION_THEME,
  VESU_MARK,
  VESU_STATION_LOOKS,
  VESU_STATION_THEME,
  roomTheme,
  stationTheme,
} from './palette.js';
import {
  DEGEN_POSTER_BOTTOM,
  DEGEN_POSTER_DEPTH,
  DEGEN_POSTER_SIZE,
  DEGEN_POSTER_SLOTS,
  DEGEN_SIGN_TEXT,
  INTERIOR_SOUTH_WALL_HEIGHT,
  INTERIOR_WALL_HEIGHT,
  BUILT_IN_COUNTER_STATIONS,
  buildFixedRoom,
  degenPosterStyle,
  type InteriorOccluder,
} from './room-builder.js';
import type { ImageTextureLoader, LabelFactory, RoomView } from './types.js';

/** Every ground floor a World can build, the opened Vault's included (D-077). */
const DEFINITIONS = fixedRoomDefinitionsFor({ vaultOpen: true });
/** Every interior floor: the ground floors and the Exchange tower's Degen floor. */
const FLOORS: readonly FixedRoomLevelMap[] = [...DEFINITIONS.map(createFixedRoom), createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL)];
const OX = ROOM_ORIGIN.x / 32;
const OZ = ROOM_ORIGIN.y / 32;

function build(building: keyof typeof FIXED_ROOM_DEFINITIONS, labels: LabelFactory = createNullLabelFactory()) {
  const map = createFixedRoom(FIXED_ROOM_DEFINITIONS[building]);
  return { map, room: buildFixedRoom(map, labels) };
}

function roomState(
  map: FixedRoomLevelMap,
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

function floatingLabelsIn(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  root.traverse((object) => {
    if (object.userData['kind'] === 'floating') found.push(object);
  });
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

/** A station's label: the Shell's text, a floating pill or, on a built-in counter, its own sign. */
function counterLabel(root: Object3D): Object3D {
  let found: Object3D | undefined;
  root.traverse((object) => {
    if (!found && object.userData['kind'] && object.userData['station'] !== undefined) found = object;
  });
  if (!found) throw new Error('no counter label');
  return found;
}

/** The ring round a station that a player can stand on: its approach, less any furniture. */
function standingApproach(map: FixedRoomLevelMap, station: FixedRoomLevelMap['stations'][number]): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let y = station.y - 1; y < station.y + station.height + 1; y++) {
    for (let x = station.x - 1; x < station.x + station.width + 1; x++) {
      if (!isFixedRoomSolidAt(map, x, y)) tiles.push({ x, y });
    }
  }
  return tiles;
}

/**
 * D-103: one station's slice of the room's shared halo mesh: its colour (as
 * an sRGB hex), its fill's and edge's opacity, and the box it covers.
 */
function haloOf(room: RoomView, station: string): { colour: number; opacity: number; edge: number; box: Box3 } {
  const { fill, edge } = stationGroup(room, station).userData['halo'] as { fill: [number, number]; edge: [number, number] };
  const mesh = meshNamed(room.group, ':halos');
  mesh.updateMatrixWorld(true);
  const colour = mesh.geometry.getAttribute('color');
  const position = mesh.geometry.getAttribute('position');
  const box = new Box3();
  const vertex = new Vector3();
  for (const [start, count] of [fill, edge]) {
    for (let i = start; i < start + count; i++) box.expandByPoint(vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  }
  // Every vertex of a slice carries the same colour; its fill and edge their own alpha.
  const hex = new Color(colour.getX(fill[0]), colour.getY(fill[0]), colour.getZ(fill[0])).getHex();
  for (const [start, count] of [fill, edge]) {
    for (let i = start; i < start + count; i++) expect(new Color(colour.getX(i), colour.getY(i), colour.getZ(i)).getHex()).toBe(hex);
  }
  return { colour: hex, opacity: colour.getW(fill[0]), edge: colour.getW(edge[0]), box };
}

/** World-space vertices of one station's slice of the room's shared halo mesh, fill and edge. */
function haloVertices(room: RoomView, station: string): Vector3[] {
  const { fill, edge } = stationGroup(room, station).userData['halo'] as { fill: [number, number]; edge: [number, number] };
  const mesh = meshNamed(room.group, ':halos');
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const found: Vector3[] = [];
  for (const [start, count] of [fill, edge]) {
    for (let i = start; i < start + count; i++) found.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  }
  return found;
}

/**
 * D-103: one counter's share of a room-wide mesh (`:counters` or
 * `:counter-screens`): the triangles standing over its own tiles, as a mesh
 * in the same place, so its colours and extent read as before.
 */
function counterPart(room: RoomView, map: FixedRoomLevelMap, station: string, suffix = ':counters'): Mesh {
  const rect = map.stations.find((candidate) => candidate.station === station)!;
  const source = meshNamed(room.group, suffix);
  source.updateMatrixWorld(true);
  const position = source.geometry.getAttribute('position');
  const colour = source.geometry.getAttribute('color');
  const positions: number[] = [];
  const colours: number[] = [];
  for (let t = 0; t < position.count; t += 3) {
    const cx = (position.getX(t) + position.getX(t + 1) + position.getX(t + 2)) / 3;
    const cz = (position.getZ(t) + position.getZ(t + 1) + position.getZ(t + 2)) / 3;
    if (cx < rect.x || cx > rect.x + rect.width || cz < rect.y - 0.1 || cz > rect.y + rect.height + 0.1) continue;
    for (let i = t; i < t + 3; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      colours.push(colour.getX(i), colour.getY(i), colour.getZ(i));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  const part = new Mesh(geometry, source.material);
  part.matrixAutoUpdate = false;
  part.matrix.copy(source.matrixWorld);
  part.matrixWorld.copy(source.matrixWorld);
  return part;
}

/** An image loader whose every request waits until the test settles it: node decodes no images. */
function deferredImages() {
  const requests: { url: string; resolve(texture: Texture): void; reject(error: unknown): void }[] = [];
  const loader: ImageTextureLoader = {
    load: (url) => new Promise<Texture>((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  return { loader, requests };
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

  it.each(FLOORS)('gives the $building $level floor one counter, label and halo per station', (map) => {
    const room = buildFixedRoom(map, createNullLabelFactory());
    const stations = room.group.children.filter((child) => child.name.startsWith('station:'));
    expect(stations).toHaveLength(map.stations.length);
    room.group.updateMatrixWorld(true);
    for (const station of map.stations) {
      const group = stationGroup(room, station.station);
      expect(group.userData['status']).toBe('locked');
      expect(group.userData['highlighted']).toBe(false);
      const label = counterLabel(group);
      expect(label.userData['text']).toBe(station.label);
      const position = label.getWorldPosition(new Vector3());
      expect(position.x).toBeCloseTo(OX + station.x + station.width / 2);
      if (BUILT_IN_COUNTER_STATIONS.includes(station.station)) {
        // Built in: a sign on the counter's own architecture, over the window and never past its front.
        expect(label.userData['kind']).toBe('sign');
        expect(position.y).toBeGreaterThan(1.6);
        expect(position.z).toBeGreaterThan(OZ + station.y);
        expect(position.z).toBeLessThanOrEqual(OZ + station.y + station.height + 0.05);
        expect(floatingLabelsIn(group)).toEqual([]);
      } else {
        expect(label.userData['kind']).toBe('floating');
        expect(position.z).toBeCloseTo(OZ + station.y + station.height / 2);
        expect(position.y).toBeGreaterThan(1.2);
      }
      // The halo lies on the approach tiles a player can stand on, and only there.
      const tiles = standingApproach(map, station);
      const halo = haloOf(room, station.station).box;
      expect(halo.min.x).toBeCloseTo(OX + Math.min(...tiles.map((tile) => tile.x)), 1);
      expect(halo.max.x).toBeCloseTo(OX + Math.max(...tiles.map((tile) => tile.x)) + 1, 1);
      expect(halo.min.z).toBeCloseTo(OZ + Math.min(...tiles.map((tile) => tile.y)), 1);
      expect(halo.max.z).toBeCloseTo(OZ + Math.max(...tiles.map((tile) => tile.y)) + 1, 1);
      expect(halo.max.y).toBeLessThan(0.05);
      for (const vertex of haloVertices(room, station.station)) {
        // Every vertex on an edge or inside a standing tile, never over furniture.
        const inside = tiles.some((tile) => vertex.x >= OX + tile.x - 1e-6 && vertex.x <= OX + tile.x + 1 + 1e-6 && vertex.z >= OZ + tile.y - 1e-6 && vertex.z <= OZ + tile.y + 1 + 1e-6);
        expect(inside).toBe(true);
      }
    }
    room.dispose();
  });

  it('drives status, highlight and label text from station presentations', () => {
    const { map, room } = build('bank');
    const group = stationGroup(room, 'bank:shielding');
    const accent = meshNamed(group, ':status').material as MeshStandardMaterial;
    const halo = { get opacity() { return haloOf(room, 'bank:shielding').opacity; } };
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
    const spy = (label: ReturnType<LabelFactory['sign']>): ReturnType<LabelFactory['sign']> => ({
      object: label.object,
      dispose: () => label.dispose(),
      setText(next) {
        setText(next);
        label.setText(next);
      },
    });
    // The Exchange's counter paints its label on a sign; any other counter floats one.
    const labels: LabelFactory = {
      sign: (text, options) => spy(base.sign(text, options)),
      floating: (text, options) => spy(base.floating(text, options)),
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
    room.group.updateMatrixWorld(true);
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

  it.each(FLOORS)('keeps every $building $level volume off the walkable floor', (map) => {
    const room = buildFixedRoom(map, createNullLabelFactory());
    const walkable = (x: number, z: number) =>
      !isFixedRoomSolidAt(map, Math.floor(x - OX), Math.floor(z - OZ));
    expect(findWalkableIntrusions(room.group, walkable, { x: OX, z: OZ, width: map.width, height: map.height })).toEqual([]);
    room.dispose();
  });

  it('dresses the Bridge room in NEAR: green light on black, a route map behind the desk', () => {
    const { map, room } = build('bridge');
    const group = stationGroup(room, 'bridge:deposit');
    // The station label heads the gateway's departure board, NEAR's uppercase mono in green on black.
    expect(counterLabel(group).userData['options']).toEqual(NEAR_DEPARTURE_HEADER);
    expect(NEAR_DEPARTURE_HEADER).toMatchObject({ titleFont: 'mono', uppercase: true, foreground: '#00ec97', background: '#000000' });
    // Locked until the Shell says otherwise, then green; the highlight's halo in the tint.
    const accent = meshNamed(group, ':status').material as MeshStandardMaterial;
    expect(accent.emissiveIntensity).toBe(0);
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null)));
    expect(accent.emissive.getHex()).toBe(new Color(NEAR.green).getHex());
    expect(haloOf(room, 'bridge:deposit').colour).toBe(new Color(NEAR.green).getHex());
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', 'bridge:deposit')));
    expect(haloOf(room, 'bridge:deposit').colour).toBe(new Color(NEAR.greenTint).getHex());
    // The route map on the north wall, self-lit in the measured green, with its
    // aurora and travelling pulse fading with that wall.
    const north = (room.occluders as readonly InteriorOccluder[]).find((occluder) => occluder.side === 'north')!;
    expect(coloursOf(meshNamed(north.object, ':lights'))).toContain(new Color(NEAR.green).getHex());
    const aurora = meshNamed(north.object, ':aurora').material as MeshBasicMaterial;
    const pulse = meshNamed(north.object, ':pulse');
    north.setOpacity(0.3);
    expect(aurora.opacity).toBeCloseTo(0.3);
    expect((pulse.material as MeshBasicMaterial).opacity).toBeCloseTo(0.3);
    north.setOpacity(1);
    const start = pulse.position.x;
    room.update(1200);
    expect(pulse.position.x).toBeGreaterThan(start);
    // Green leads, amber marks the one pending route, and there is no orange anywhere.
    const hues = huesOf(room.group);
    expect(hues.filter(isOrange)).toEqual([]);
    expect(hues.filter(isGreen).length).toBeGreaterThan(0);
    expect(coloursOf(meshNamed(room.group, ':wall-west:lights'))).toContain(new Color(NEAR.amber).getHex());
    room.dispose();
  });

  it('dresses the Bank\'s staking and unstaking counters in Endur while the room and its shielding counters keep STRK20', () => {
    const { map, room } = build('bank');
    const staking = stationGroup(room, 'bank:staking');
    const shielding = stationGroup(room, 'bank:shielding');
    // Its own counter, on its own tiles east of shielding and unshielding (D-103).
    room.group.updateMatrixWorld(true);
    const counter = new Box3().setFromObject(counterPart(room, map, 'bank:staking'));
    expect(counter.min.x).toBeGreaterThanOrEqual(OX + 10);
    expect(counter.max.x).toBeLessThanOrEqual(OX + 12);
    expect(counter.min.z).toBeGreaterThanOrEqual(OZ + 3);
    expect(counter.max.z).toBeLessThanOrEqual(OZ + 4);
    // A light Endur kiosk (white top and card, mint field, green pill and
    // droplet, dark-green trim and wave), none of which reaches shielding.
    const endur = [ENDUR.card, ENDUR.band, ENDUR.green, ENDUR.greenDeep, ENDUR.dark].map((hex) => new Color(hex).getHex());
    for (const station of ['bank:staking', 'bank:unstaking']) {
      const colours = coloursOf(counterPart(room, map, station));
      for (const hex of endur) expect(colours).toContain(hex);
    }
    for (const station of ['bank:shielding', 'bank:unshielding']) {
      const colours = coloursOf(counterPart(room, map, station));
      for (const hex of endur) expect(colours).not.toContain(hex);
    }
    expect(counter.max.y).toBeGreaterThan(1.25);

    // Three distinct states in Endur's looks: locked is a calm grey.
    const accent = (group: Object3D) => meshNamed(group, ':status').material as MeshStandardMaterial;
    const state = (group: Object3D) => ({
      colour: accent(group).color.getHex(),
      glow: accent(group).emissiveIntensity,
      halo: haloOf(room, group.userData['station'] as string).colour,
      opacity: haloOf(room, group.userData['station'] as string).opacity,
    });
    const show = (status: 'available' | 'locked', highlighted: 'bank:staking' | null, label = 'STAKE') =>
      room.setStations(
        fixedRoomStationPresentations(map, {
          ...roomState(map, status, highlighted),
          stations: map.stations.map((station) => ({
            station: station.station,
            label: station.station === 'bank:staking' ? label : station.label,
            status,
          })),
        }),
      );
    const locked = state(staking);
    expect(locked.colour).toBe(new Color(ENDUR_STATION_LOOKS.locked.color).getHex());
    expect(locked.glow).toBe(0);
    const hsl = { h: 0, s: 0, l: 0 };
    accent(staking).color.getHSL(hsl, SRGBColorSpace);
    expect(hsl.s).toBeLessThan(0.1);
    show('available', null);
    const available = state(staking);
    expect(available.colour).toBe(new Color(ENDUR.green).getHex());
    expect(state(shielding).colour).toBe(new Color(STRK20_STATION_LOOKS.available.color).getHex());
    show('available', 'bank:staking', 'STAKE STRK');
    const highlighted = state(staking);
    expect(new Set([locked.colour, available.colour, highlighted.colour]).size).toBe(3);
    expect(highlighted.glow).toBeGreaterThan(available.glow);
    expect(highlighted.halo).not.toBe(available.halo);
    expect(locked.opacity).toBeLessThan(available.opacity);
    expect(available.opacity).toBeLessThan(highlighted.opacity);
    expect(accent(shielding).emissive.getHex()).toBe(new Color(STRK20.orange).getHex());
    // The label plate renders the Shell's label, as an Endur pill badge, and
    // the status panel below it names Endur on a plate in Endur's look.
    expect(floatingLabel(staking).userData['text']).toBe('STAKE STRK');
    const endurPlate = staking.children.find((child) => child.userData['brand'] === 'bank:staking');
    expect(endurPlate?.userData['text']).toBe('Endur');
    expect(endurPlate?.userData['options']).toMatchObject({ foreground: '#0d1a17', background: '#ffffff', accent: '#2db882' });
    expect(endurPlate!.position.y).toBeGreaterThan(0.3);
    expect(endurPlate!.position.y).toBeLessThan(0.72);
    expect(endurPlate!.position.z).toBeGreaterThan(meshNamed(staking, ':status').geometry.boundingBox!.max.z);
    expect(shielding.children.some((child) => child.userData['brand'])).toBe(false);
    expect(floatingLabel(staking).userData['options']).toMatchObject({ foreground: '#0d1a17', font: 'sans', cornerRadius: 0.5 });
    expect(floatingLabel(shielding).userData['options']).toMatchObject({ font: 'mono', uppercase: true });

    const unstaking = stationGroup(room, 'bank:unstaking');
    expect(unstaking.children.find((child) => child.userData['brand'] === 'bank:unstaking')?.userData['text']).toBe('Endur');
    expect(floatingLabel(unstaking).userData['options']).toEqual(floatingLabel(staking).userData['options']);
    expect(stationGroup(room, 'bank:unshielding').children.some((child) => child.userData['brand'])).toBe(false);

    // D-103: the counter's own group holds only what its state changes, the
    // status panel and the beacon (two meshes) with its label and plate; its
    // desk and halo are in the room's shared meshes. All dispose with the room.
    const meshes: Mesh[] = [];
    staking.traverse((object) => object instanceof Mesh && meshes.push(object));
    expect(meshes.map((mesh) => mesh.name)).toEqual(['station:bank:staking:status', 'station:bank:staking:beacon']);
    for (const suffix of [':counters', ':counter-screens', ':halos']) meshes.push(meshNamed(room.group, suffix));
    const spies = [...new Set(meshes.flatMap((mesh) => [mesh.geometry, mesh.material as Material]))].map((value) =>
      vi.spyOn(value, 'dispose'),
    );
    room.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(endurPlate!.userData['disposed']).toBe(true);
  });

  it('dresses the opened Vault in Vesu (D-077): its light pages, its blue, its V and its wordmark', () => {
    const theme = roomTheme('vault');
    expect(theme).toBe(ROOM_THEMES.vault);
    expect(theme).not.toBe(DEFAULT_ROOM_THEME);
    expect(theme).toMatchObject({
      decor: 'vesu',
      floorA: VESU.white,
      floorB: VESU.page,
      wall: VESU.white,
      wallLower: VESU.blueSoft,
      wallTop: VESU.ink,
      skirting: VESU.ink,
      trim: VESU.blue,
      exitGlow: VESU.blue,
      stationLooks: VESU_STATION_LOOKS,
    });
    // Its counters wear Vesu's own look, as the Bank's staking counter wears
    // Endur's: lending's two, and borrowing's two as their twins (D-083, D-103).
    expect(stationTheme(theme, VAULT_SUPPLY_STATION)).toBe(VESU_STATION_THEME);
    expect(stationTheme(theme, VAULT_REDEEM_STATION)).toBe(VESU_STATION_THEME);
    expect(stationTheme(theme, VAULT_BORROW_STATION)).toBe(VESU_BORROW_STATION_THEME);
    expect(stationTheme(theme, VAULT_REPAY_STATION)).toBe(VESU_BORROW_STATION_THEME);
    const map = createFixedRoom(VAULT_ROOM_DEFINITION);
    const room = buildFixedRoom(map, createNullLabelFactory());
    expect(room.building).toBe('vault');
    expect(room.group.name).toBe('room:vault');
    // Its SUPPLY counter, locked until the Shell opens it, under a label in
    // the style of Vesu's secondary button.
    const counter = stationGroup(room, VAULT_SUPPLY_STATION);
    expect(counter.userData['status']).toBe('locked');
    const label = floatingLabel(counter);
    expect(label.userData['text']).toBe('SUPPLY');
    expect(label.userData['options']).toMatchObject({
      font: 'sans',
      cornerRadius: 0.22,
      foreground: '#2030b6',
      background: 'rgba(224,229,255,0.96)',
      border: '#2c41f6',
    });
    // A light room: every walkable floor tile is Vesu's white, page grey or periwinkle.
    room.group.updateMatrixWorld(true);
    const floor = meshNamed(room.group, ':floor');
    const position = floor.geometry.getAttribute('position');
    const paint = floor.geometry.getAttribute('color');
    const vertex = new Vector3();
    const hsl = { h: 0, s: 0, l: 0 };
    let inside = 0;
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(floor.matrixWorld);
      const [x, z] = [vertex.x - OX, vertex.z - OZ];
      if (x < 1.5 || x > map.width - 1.5 || z < 1.5 || z > map.height - 1.5) continue;
      inside += 1;
      new Color().setRGB(paint.getX(i), paint.getY(i), paint.getZ(i)).getHSL(hsl, SRGBColorSpace);
      expect(hsl.l).toBeGreaterThan(0.85);
    }
    expect(inside).toBeGreaterThan(100);
    // Locked is a calm grey; ready is the blue; stepping up glows brighter
    // with a deeper halo, which reads on the white floor.
    const accent = meshNamed(counter, ':status').material as MeshStandardMaterial;
    const halo = {
      get color() { return new Color(haloOf(room, VAULT_SUPPLY_STATION).colour); },
      get opacity() { return haloOf(room, VAULT_SUPPLY_STATION).opacity; },
    };
    accent.color.getHSL(hsl, SRGBColorSpace);
    expect(hsl.s).toBeLessThan(0.25);
    expect(accent.emissiveIntensity).toBe(0);
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null)));
    expect(accent.emissive.getHex()).toBe(new Color(VESU.blue).getHex());
    expect(halo.color.getHex()).toBe(new Color(VESU.blue).getHex());
    const ready = { glow: accent.emissiveIntensity, halo: halo.opacity };
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', VAULT_SUPPLY_STATION)));
    expect(accent.emissiveIntensity).toBeGreaterThan(ready.glow);
    expect(halo.opacity).toBeGreaterThan(ready.halo);
    expect(halo.color.getHex()).toBe(new Color(VESU.blueText).getHex());
    // Behind the counter, self-lit on the north wall: Vesu's avatar (the V on
    // ink) between market boards in the app's white, page grey and blues.
    const north = (room.occluders as readonly InteriorOccluder[]).find((occluder) => occluder.side === 'north')!;
    const lights = coloursOf(meshNamed(north.object, ':lights'));
    for (const hex of [VESU.white, VESU.page, VESU.fill, VESU.blueSoft, VESU.blue, VESU.blueText, VESU.ink]) {
      expect(lights).toContain(new Color(hex).getHex());
    }
    for (const [, hex] of VESU_MARK.dark.bar) expect(lights).toContain(new Color(hex).getHex());
    // A soft light round the avatar, fading with its wall.
    const glow = meshNamed(north.object, ':glow').material as Material;
    expect(glow.blending).toBe(AdditiveBlending);
    north.setOpacity(0.5);
    expect(glow.opacity).toBeCloseTo(0.5);
    north.setOpacity(1);
    // The counter: a white desk under an ink top, the supply card and the V on
    // it, and Vesu's name on its status panel, as Endur's is on its own.
    const desk = coloursOf(counterPart(room, map, VAULT_SUPPLY_STATION));
    for (const hex of [VESU_STATION_THEME.kioskTop, VESU.ink, VESU.fill]) expect(desk).toContain(new Color(hex).getHex());
    // Its body is white, shaded towards the floor.
    expect(Math.max(...desk.map((hex) => new Color(hex).getHSL(hsl, SRGBColorSpace).l))).toBeGreaterThan(0.95);
    const card = coloursOf(counterPart(room, map, VAULT_SUPPLY_STATION, ':counter-screens'));
    for (const hex of [VESU.white, VESU.page, VESU.blueSoft, VESU.blue]) expect(card).toContain(new Color(hex).getHex());
    for (const [, hex] of VESU_MARK.light.bar) expect(card).toContain(new Color(hex).getHex());
    const plate = counter.children.find((child) => child.userData['brand'] === VAULT_SUPPLY_STATION)!;
    expect(plate.userData['text']).toBe('vesu');
    expect(plate.userData['options']).toMatchObject({ lowercase: true, foreground: '#0a0a0a', background: '#ffffff', titleStretch: 1.4 });
    expect(plate.position.z).toBeGreaterThan(meshNamed(counter, ':status').geometry.boundingBox!.max.z);
    // Words: the Shell's label, and Vesu's name, on the plate and over each
    // bank of lockers. No figure, rate or symbol anywhere.
    const labels: Object3D[] = [];
    room.group.traverse((object) => {
      if (object.userData['kind']) labels.push(object);
    });
    expect(labels.filter((object) => object.userData['kind'] === 'floating').map((object) => object.userData['text'])).toEqual([
      'SUPPLY',
      'REDEEM',
      'BORROW',
      'REPAY',
    ]);
    // Two wordmarks over the lockers, and one plate per counter.
    expect(labels.filter((object) => object.userData['kind'] !== 'floating').map((object) => object.userData['text'])).toEqual(
      Array(6).fill('vesu'),
    );
    const wordmarks = labels.filter((object) => object.userData['area'] === 'vesu-wordmark');
    expect(wordmarks).toHaveLength(2);
    for (const wordmark of wordmarks) expect(wordmark.userData['options']).toMatchObject({ lowercase: true, foreground: '#0a0a0a', borderWidth: 0 });
    // Blue leads. Orange and green, the Bank's and the Bridge's and Endur's,
    // appear only in Vesu's V: the avatar behind the middle of the counters,
    // the marks on the two supply-card desks and the floor's inlay.
    const anchor = map.width / 2;
    const exit = map.exit!;
    const deskMark = (station: string) => {
      const rect = map.stations.find((candidate) => candidate.station === station)!;
      const cx = rect.x + rect.width / 2;
      return { x0: cx + 0.4, x1: cx + 0.95, y0: 0.99, y1: 1.4, z0: 3.3, z1: 3.8 };
    };
    const marks = [
      { x0: anchor - 1, x1: anchor + 1, y0: 0.3, y1: 2, z0: 0.5, z1: 0.8 },
      deskMark(VAULT_SUPPLY_STATION),
      deskMark(VAULT_REDEEM_STATION),
      { x0: exit.x + exit.width / 2 - 0.7, x1: exit.x + exit.width / 2 + 0.7, y0: -0.01, y1: 0.02, z0: exit.y - 2.6, z1: exit.y - 1.2 },
    ];
    const outside: string[] = [];
    let marked = 0;
    const colour = new Color();
    room.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const attribute = object.geometry.getAttribute('color');
      const points = object.geometry.getAttribute('position');
      for (let i = 0; attribute && i < attribute.count; i++) {
        colour.setRGB(attribute.getX(i), attribute.getY(i), attribute.getZ(i)).getHSL(hsl, SRGBColorSpace);
        const hue = { h: hsl.h * 360, s: hsl.s, l: hsl.l };
        if (!isOrange(hue) && !isGreen(hue)) continue;
        vertex.fromBufferAttribute(points, i).applyMatrix4(object.matrixWorld);
        const [x, y, z] = [vertex.x - OX, vertex.y, vertex.z - OZ];
        const inMark = marks.some((box) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1);
        if (inMark) marked += 1;
        else outside.push(`${object.name} ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`);
      }
    });
    expect(outside).toEqual([]);
    expect(marked).toBeGreaterThan(100);
    room.dispose();
  });

  it('gives the Vault\'s borrowing and repaying their own counters in Vesu\'s look, a loan card on each (D-083, D-103)', () => {
    const map = createFixedRoom(VAULT_ROOM_DEFINITION);
    const room = buildFixedRoom(map, createNullLabelFactory());
    const lending = stationGroup(room, VAULT_SUPPLY_STATION);
    const borrow = stationGroup(room, VAULT_BORROW_STATION);
    const repay = stationGroup(room, VAULT_REPAY_STATION);
    expect(borrow.userData['status']).toBe('locked');
    // West to east: SUPPLY, REDEEM, BORROW, REPAY, each desk over its own tiles.
    room.group.updateMatrixWorld(true);
    const centre = (station: string): Vector3 => new Box3().setFromObject(counterPart(room, map, station)).getCenter(new Vector3());
    expect([VAULT_SUPPLY_STATION, VAULT_REDEEM_STATION, VAULT_BORROW_STATION, VAULT_REPAY_STATION].map((station) => Math.round(centre(station).x - OX))).toEqual([3, 7, 11, 15]);
    expect(floatingLabel(repay).userData['text']).toBe('REPAY');
    expect(floatingLabel(repay).userData['options']).toEqual(floatingLabel(borrow).userData['options']);
    expect(coloursOf(counterPart(room, map, VAULT_REPAY_STATION, ':counter-screens')).sort()).toEqual(
      coloursOf(counterPart(room, map, VAULT_BORROW_STATION, ':counter-screens')).sort(),
    );
    // The same label and plate as lending, so the two read as one brand.
    const label = floatingLabel(borrow);
    expect(label.userData['text']).toBe('BORROW');
    expect(label.userData['options']).toEqual(floatingLabel(lending).userData['options']);
    const plate = borrow.children.find((child) => child.userData['brand'] === VAULT_BORROW_STATION)!;
    expect(plate.userData['text']).toBe('vesu');
    expect(plate.userData['options']).toMatchObject({ lowercase: true, foreground: '#0a0a0a', background: '#ffffff', titleStretch: 1.4 });
    expect(plate.position.z).toBeGreaterThan(meshNamed(borrow, ':status').geometry.boundingBox!.max.z);
    // The same desk: white under an ink top.
    const desk = coloursOf(counterPart(room, map, VAULT_BORROW_STATION));
    for (const hex of [VESU_BORROW_STATION_THEME.kioskTop, VESU.ink, VESU.fill]) expect(desk).toContain(new Color(hex).getHex());
    // The loan card: two token fields (a night and a blue disc), the health
    // bar's blues from pale to night with its ink marker, the primary button.
    // Only Vesu's own tokens: no V on this desk, and no orange or green.
    const card = coloursOf(counterPart(room, map, VAULT_BORROW_STATION, ':counter-screens'));
    const tokens = [VESU.white, VESU.page, VESU.muted, VESU.ink, VESU.blueSoft, VESU.blue, VESU.blueText, VESU.night];
    for (const hex of tokens) expect(card).toContain(new Color(hex).getHex());
    expect(card.filter((hex) => !tokens.some((token) => new Color(token).getHex() === hex))).toEqual([]);
    expect(coloursOf(counterPart(room, map, VAULT_SUPPLY_STATION, ':counter-screens'))).not.toContain(new Color(VESU.night).getHex());
    // The health bar runs left to right from pale to night along the card's top.
    const screen = counterPart(room, map, VAULT_BORROW_STATION, ':counter-screens');
    const position = screen.geometry.getAttribute('position');
    const paint = screen.geometry.getAttribute('color');
    const colour = new Color();
    const segmentX = [VESU.blueSoft, VESU.blue, VESU.blueText, VESU.night].map((hex) => {
      const xs: number[] = [];
      for (let i = 0; i < position.count; i++) {
        if (colour.setRGB(paint.getX(i), paint.getY(i), paint.getZ(i)).getHex() !== new Color(hex).getHex()) continue;
        if (position.getY(i) > 1.5) xs.push(position.getX(i));
      }
      expect(xs.length).toBeGreaterThan(0);
      return Math.min(...xs);
    });
    expect([...segmentX].sort((a, b) => a - b)).toEqual(segmentX);
    // It lights alone: highlighting borrowing leaves its neighbours' halos alone.
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', VAULT_BORROW_STATION)));
    const halo = (station: string): number => haloOf(room, station).opacity;
    expect(halo(VAULT_BORROW_STATION)).toBeGreaterThan(halo(VAULT_SUPPLY_STATION));
    expect(halo(VAULT_BORROW_STATION)).toBeGreaterThan(halo(VAULT_REPAY_STATION));
    expect(halo(VAULT_REDEEM_STATION)).toBe(halo(VAULT_REPAY_STATION));
    // Each costs what the lending counter costs.
    const meshes = (group: Object3D): number => {
      let count = 0;
      group.traverse((object) => object instanceof Mesh && (count += 1));
      return count;
    };
    expect(meshes(borrow)).toBe(meshes(lending));
    expect(meshes(repay)).toBe(meshes(lending));
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

describe('counters built into their rooms', () => {
  const builtIn = FLOORS.filter((map) => map.stations.some((station) => BUILT_IN_COUNTER_STATIONS.includes(station.station)));
  const signsIn = (root: Object3D): Object3D[] => {
    const found: Object3D[] = [];
    root.traverse((object) => {
      if (object.userData['kind'] === 'sign') found.push(object);
    });
    return found;
  };
  /** The tallest surface of a mesh over a room rectangle, sampled by rays straight down. */
  const heightOver = (mesh: Mesh, rect: { x: number; y: number; width: number; height: number }): number => {
    const ray = new Raycaster();
    let top = -Infinity;
    for (let i = 0; i < rect.width * 5; i++) {
      for (let j = 0; j < rect.height * 5; j++) {
        ray.set(new Vector3(OX + rect.x + (i + 0.5) / 5, 10, OZ + rect.y + (j + 0.5) / 5), new Vector3(0, -1, 0));
        const hit = ray.intersectObject(mesh, false)[0];
        if (hit) top = Math.max(top, hit.point.y);
      }
    }
    return top;
  };

  it('builds the Exchange, Degen floor, Post Office and Bridge counters in, and leaves the Bank and Vault as they were', () => {
    expect([...BUILT_IN_COUNTER_STATIONS].sort()).toEqual(['bridge:deposit', 'exchange:degen', 'exchange:swap', 'post-office:transfer']);
    expect(builtIn.map((map) => `${map.building}:${map.level}`).sort()).toEqual(['bridge:ground', 'exchange:degen', 'exchange:ground', 'post-office:ground']);
  });

  it.each(builtIn)('stands the $building $level counter\'s furniture on its fixtures, desk-high and more', (map) => {
    const room = buildFixedRoom(map, createNullLabelFactory());
    room.group.updateMatrixWorld(true);
    const station = map.stations[0]!;
    // D-103: the room's counters share one lit mesh; these rooms hold one counter each.
    const counter = meshNamed(room.group, ':counters');
    // Each piece of furniture round the counter stands at least table-high, and the counter desk-high.
    for (const fixture of map.fixtures.filter((candidate) => candidate.prop === undefined)) {
      expect(heightOver(counter, fixture), JSON.stringify(fixture)).toBeGreaterThan(0.75);
    }
    expect(heightOver(counter, station)).toBeGreaterThan(0.95);
    // The state colour lights the architecture too, beyond the counter's own front.
    const status = new Box3().setFromObject(meshNamed(stationGroup(room, station.station), ':status'));
    expect(status.max.y).toBeGreaterThan(1.6);
    room.dispose();
  });

  it.each(builtIn)('draws each free-standing prop on the $building $level floor, at no draw call of its own', (map) => {
    const room = buildFixedRoom(map, createNullLabelFactory());
    room.group.updateMatrixWorld(true);
    const floor = meshNamed(room.group, ':floor');
    const props = map.fixtures.filter((fixture) => fixture.prop !== undefined);
    expect(props.length).toBeGreaterThan(0);
    for (const prop of props) {
      const tall = verticesIn(floor, OX + prop.x, OZ + prop.y, OX + prop.x + prop.width, OZ + prop.y + prop.height).filter((vertex) => vertex.y > 0.7);
      expect(tall.length, prop.prop).toBeGreaterThan(0);
    }
    room.dispose();
  });

  it('heads each counter with its building\'s own sign, and the Post Office adds SEND over its window', () => {
    const expected: Record<string, unknown> = {
      'exchange:swap': AVNU_COUNTER_HEADER,
      'exchange:degen': DEGEN_COUNTER_HEADER,
      'post-office:transfer': POST_OFFICE_WINDOW_SIGN,
      'bridge:deposit': NEAR_DEPARTURE_HEADER,
    };
    for (const map of builtIn) {
      const room = buildFixedRoom(map, createNullLabelFactory());
      room.group.updateMatrixWorld(true);
      const station = map.stations[0]!;
      const group = stationGroup(room, station.station);
      expect(counterLabel(group).userData['options']).toEqual(expected[station.station]);
      const others = signsIn(group).filter((sign) => sign.userData['station'] === undefined);
      if (map.building === 'post-office') {
        expect(others.map((sign) => sign.userData['text'])).toEqual([POST_OFFICE_SEND_TEXT]);
        expect(others[0]!.userData['options']).toEqual(POST_OFFICE_SEND_SIGN);
        // SEND sits on the fascia right over the window's ticket.
        const send = others[0]!.getWorldPosition(new Vector3());
        const ticket = counterLabel(group).getWorldPosition(new Vector3());
        expect(send.x).toBeCloseTo(ticket.x);
        expect(send.y).toBeGreaterThan(ticket.y);
      } else {
        expect(others).toEqual([]);
      }
      room.dispose();
    }
  });

  it('dresses each counter in its building\'s colours', () => {
    const counterColours = (building: string, level = 'ground'): number[] => {
      const map = builtIn.find((candidate) => candidate.building === building && candidate.level === level)!;
      const room = buildFixedRoom(map, createNullLabelFactory());
      const colours = [...coloursOf(meshNamed(room.group, ':counters')), ...coloursOf(meshNamed(room.group, ':counter-screens'))];
      room.dispose();
      return colours;
    };
    const has = (colours: number[], hex: number) => colours.includes(new Color(hex).getHex());
    // avnu's navy and blue; the Degen floor's neon; the airmail red and blue; NEAR's green and teal.
    expect(has(counterColours('exchange'), AVNU.blue)).toBe(true);
    expect(has(counterColours('exchange', 'degen'), DEGEN.pink)).toBe(true);
    expect(has(counterColours('exchange', 'degen'), DEGEN.cyan)).toBe(true);
    const post = counterColours('post-office');
    expect(has(post, 0xc23b2b) && has(post, 0x2f5fa3) && has(post, 0xfbf4e4)).toBe(true);
    const bridge = counterColours('bridge');
    expect(has(bridge, NEAR.green) && has(bridge, NEAR.teal)).toBe(true);
  });
});

describe('the Exchange tower floors', () => {
  const degenMap = createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL);
  const labelsIn = (root: Object3D, key: string): Object3D[] => {
    const found: Object3D[] = [];
    root.traverse((object) => {
      if (object.userData[key] !== undefined && object.userData['kind']) found.push(object);
    });
    return found;
  };
  /** The Degen floor's textured poster planes, whether or not their art has arrived. */
  const postersIn = (root: Object3D): Mesh<BufferGeometry, MeshBasicMaterial>[] => {
    const found: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
    root.traverse((object) => {
      if (object instanceof Mesh && object.userData['poster'] !== undefined) found.push(object as Mesh<BufferGeometry, MeshBasicMaterial>);
    });
    return found;
  };
  /** Each tall wall's inner face in world units. */
  const faces = { north: { axis: 'z', at: OZ + 0.55 }, west: { axis: 'x', at: OX + 0.55 }, east: { axis: 'x', at: OX + degenMap.width - 0.55 } } as const;
  /** The yaw that turns a +Z-facing board or plane to face out of each wall. */
  const FACING = { north: 0, west: Math.PI / 2, east: -Math.PI / 2 } as const;
  const drawCalls = (root: Object3D): number => {
    let calls = 0;
    root.traverse((object) => {
      // A mesh is a call; so is each canvas label, which the null factory draws as an Object3D.
      if (object instanceof Mesh || object.userData['kind']) calls += 1;
    });
    return calls;
  };
  /** Let every settled load's handlers run. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('builds the Degen floor over its own grid, its counter locked until the Shell opens it', () => {
    const room = buildFixedRoom(degenMap, createNullLabelFactory());
    expect(room.building).toBe('exchange');
    expect(room.group.name).toBe('room:exchange:degen');
    expect(room.group.userData['level']).toBe('degen');
    expect(room.group.position.toArray()).toEqual([OX, 0, OZ]);
    const stations = room.group.children.filter((child) => child.name.startsWith('station:'));
    expect(stations.map((child) => child.userData['station'])).toEqual([EXCHANGE_DEGEN_STATION]);
    const counter = stationGroup(room, EXCHANGE_DEGEN_STATION);
    expect(counter.userData['status']).toBe('locked');
    expect(counterLabel(counter).userData['text']).toBe('DEGEN SWAP');
    expect(counterLabel(counter).userData['options']).toEqual(DEGEN_COUNTER_HEADER);
    const accent = meshNamed(counter, ':status').material as MeshStandardMaterial;
    expect(accent.color.getHex()).toBe(new Color(DEGEN_STATION_LOOKS.locked.color).getHex());
    // Available and stepped up to: hot pink with a lime halo, and the Shell's label.
    room.setStations(fixedRoomStationPresentations(degenMap, roomState(degenMap, 'available', EXCHANGE_DEGEN_STATION, 'DEGEN')));
    expect(counter.userData['status']).toBe('available');
    expect(counterLabel(counter).userData['text']).toBe('DEGEN');
    expect(accent.emissive.getHex()).toBe(new Color(DEGEN_STATION_LOOKS.highlighted.emissive).getHex());
    // No exit: the south wall is one unbroken ledge, the lifts are the way out.
    expect(degenMap.exit).toBeNull();
    expect(degenMap.tiles.at(-1)!.every((tile) => tile === 'wall')).toBe(true);
    room.group.updateMatrixWorld(true);
    const south = new Box3().setFromObject(meshNamed(room.group, ':south-wall'));
    expect(south.min.x).toBeCloseTo(OX);
    expect(south.max.x).toBeCloseTo(OX + degenMap.width);
    room.dispose();
  });

  it('without a loader, hangs each DEGEN_TOKENS entry\'s stand-in poster, in the list\'s order, colours and words', () => {
    expect(DEGEN_TOKENS.length).toBeGreaterThanOrEqual(3);
    expect(DEGEN_TOKENS.length).toBeLessThanOrEqual(DEGEN_POSTER_SLOTS.length);
    expect(DEGEN_TOKENS.slice(0, 3).map((token) => token.ticker)).toEqual(['LORDS', 'DREAMS', 'SLAY']);
    // Researched entries only now: no slot is still a placeholder.
    for (const token of DEGEN_TOKENS) expect(token.placeholder, token.ticker).not.toBe(true);
    const room = buildFixedRoom(degenMap, createNullLabelFactory());
    room.group.updateMatrixWorld(true);
    // No loader, so no art: every poster is its procedural stand-in and board.
    expect(postersIn(room.group)).toEqual([]);
    const posters = labelsIn(room.group, 'token');
    // The scene groups posters by wall, so match each token to its poster by
    // text rather than by traversal order.
    const textOf = (token: (typeof DEGEN_TOKENS)[number]) => `${token.ticker}\n${token.name}`;
    expect(posters.map((poster) => poster.userData['text']).sort()).toEqual(DEGEN_TOKENS.map(textOf).sort());
    DEGEN_TOKENS.forEach((token, index) => {
      const poster = posters.find((candidate) => candidate.userData['text'] === textOf(token))!;
      expect(poster.userData['kind']).toBe('sign');
      expect(poster.userData['options']).toEqual(degenPosterStyle(token));
      expect(poster.userData['options']).toMatchObject({ background: `#${token.colors.background.toString(16).padStart(6, '0')}` });
      // On its slot's wall, just proud of it, facing into the room.
      const slot = DEGEN_POSTER_SLOTS[index]!;
      const position = poster.getWorldPosition(new Vector3());
      const face = faces[slot.wall];
      expect(Math.abs(position[face.axis] - face.at), token.ticker).toBeLessThan(0.08);
      expect(position.y).toBeGreaterThan(DEGEN_POSTER_BOTTOM);
      expect(position.y).toBeLessThan(DEGEN_POSTER_BOTTOM + DEGEN_POSTER_SIZE.height);
      expect(poster.rotation.y).toBeCloseTo(FACING[slot.wall]);
    });
    // The floor's own sign, and never a price: no currency, percentage or decimal on any board.
    const sign = labelsIn(room.group, 'area').find((label) => label.userData['area'] === 'degen-sign')!;
    expect(sign.userData['text']).toBe(DEGEN_SIGN_TEXT);
    for (const label of [...posters, sign]) expect(label.userData['text']).not.toMatch(/[$%\u20ac\u00a3]|\d[.,]\d/);
    room.dispose();
  });

  it('loads each poster\'s own art through the injected loader, as an sRGB mipmapped texture on its wall', async () => {
    const images = deferredImages();
    const room = buildFixedRoom(degenMap, createNullLabelFactory(), ROOM_ORIGIN, images.loader);
    room.group.updateMatrixWorld(true);
    // One request per poster, for that token's bundled art, in the list's order.
    expect(images.requests.map((request) => request.url)).toEqual(DEGEN_TOKENS.map((token) => token.poster));
    // While the art loads the stand-ins show: the planes wait hidden, and no board spends a call.
    const posters = postersIn(room.group);
    expect(posters.map((poster) => poster.userData['poster']).sort()).toEqual(DEGEN_TOKENS.map((token) => token.ticker).sort());
    expect(posters.every((poster) => !poster.visible)).toBe(true);
    expect(labelsIn(room.group, 'token')).toEqual([]);

    const textures = images.requests.map(() => new Texture());
    images.requests.forEach((request, index) => request.resolve(textures[index]!));
    await settle();
    DEGEN_TOKENS.forEach((token, index) => {
      const poster = posters.find((candidate) => candidate.userData['poster'] === token.ticker)!;
      const texture = textures[index]!;
      expect(poster.visible, token.ticker).toBe(true);
      expect(poster.material.map).toBe(texture);
      expect(poster.material.toneMapped).toBe(false);
      expect(texture.colorSpace).toBe(SRGBColorSpace);
      expect(texture.generateMipmaps).toBe(true);
      expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
      expect(texture.magFilter).toBe(LinearFilter);
      expect(texture.anisotropy).toBe(4);
      // The art's own 2:3 portrait, on its slot's wall, facing into the room.
      const plane = poster.geometry as PlaneGeometry;
      expect(plane.parameters.width / plane.parameters.height).toBeCloseTo(512 / 768);
      expect(plane.parameters.height).toBe(DEGEN_POSTER_SIZE.height);
      const slot = DEGEN_POSTER_SLOTS[index]!;
      const position = poster.getWorldPosition(new Vector3());
      const face = faces[slot.wall];
      expect(Math.abs(Math.abs(position[face.axis] - face.at) - DEGEN_POSTER_DEPTH), token.ticker).toBeLessThan(1e-6);
      expect(position[face.axis === 'z' ? 'x' : 'z']).toBeCloseTo((face.axis === 'z' ? OX : OZ) + slot.u);
      expect(position.y).toBeCloseTo(DEGEN_POSTER_BOTTOM + DEGEN_POSTER_SIZE.height / 2);
      expect(poster.rotation.y).toBeCloseTo(FACING[slot.wall]);
    });
    // Art replaces boards one for one, so the floor keeps its budget.
    expect(labelsIn(room.group, 'token')).toEqual([]);
    const standIn = buildFixedRoom(degenMap, createNullLabelFactory());
    expect(drawCalls(room.group)).toBe(drawCalls(standIn.group));
    standIn.dispose();
    room.dispose();
  });

  it('fades each poster with the wall it hangs on', async () => {
    const images = deferredImages();
    const room = buildFixedRoom(degenMap, createNullLabelFactory(), ROOM_ORIGIN, images.loader);
    for (const request of images.requests) request.resolve(new Texture());
    await settle();
    const occluders = room.occluders as readonly InteriorOccluder[];
    for (const side of ['north', 'west', 'east'] as const) {
      const wall = occluders.find((occluder) => occluder.side === side)!;
      const own = postersIn(wall.object);
      const others = postersIn(room.group).filter((poster) => !own.includes(poster));
      expect(own.length, side).toBe(DEGEN_POSTER_SLOTS.filter((slot) => slot.wall === side).length);
      wall.setOpacity(0.3);
      for (const poster of own) expect(poster.material.opacity).toBeCloseTo(0.3);
      for (const poster of others) expect(poster.material.opacity).toBe(1);
      wall.setOpacity(1);
      for (const poster of own) expect(poster.material.transparent).toBe(false);
    }
    room.dispose();
  });

  it('keeps a poster\'s procedural stand-in, and gives it its board, when its art fails', async () => {
    const images = deferredImages();
    const failing = DEGEN_TOKENS[2]!;
    const room = buildFixedRoom(degenMap, createNullLabelFactory(), ROOM_ORIGIN, images.loader);
    images.requests.forEach((request) => {
      if (request.url === failing.poster) request.reject(new Error('decode failed'));
      else request.resolve(new Texture());
    });
    await settle();
    // The failed art's plane leaves; its board takes the call it would have spent.
    const posters = postersIn(room.group);
    expect(posters.map((poster) => poster.userData['poster'])).not.toContain(failing.ticker);
    expect(posters).toHaveLength(DEGEN_TOKENS.length - 1);
    expect(posters.every((poster) => poster.visible)).toBe(true);
    const boards = labelsIn(room.group, 'token');
    expect(boards.map((board) => board.userData['text'])).toEqual([`${failing.ticker}\n${failing.name}`]);
    expect(boards[0]!.userData['options']).toEqual(degenPosterStyle(failing));
    const standIn = buildFixedRoom(degenMap, createNullLabelFactory());
    expect(drawCalls(room.group)).toBe(drawCalls(standIn.group));
    standIn.dispose();
    room.dispose();
    // A loader that throws outright is a failed load too, never a broken room.
    const throwing: ImageTextureLoader = {
      load() {
        throw new Error('no decoder');
      },
    };
    const fallback = buildFixedRoom(degenMap, createNullLabelFactory(), ROOM_ORIGIN, throwing);
    await settle();
    expect(postersIn(fallback.group)).toEqual([]);
    expect(labelsIn(fallback.group, 'token')).toHaveLength(DEGEN_TOKENS.length);
    fallback.dispose();
  });

  it('disposes poster art with the room, and art that arrives after it at once', async () => {
    const images = deferredImages();
    const labels = createNullLabelFactory();
    const signs = vi.spyOn(labels, 'sign');
    const room = buildFixedRoom(degenMap, labels, ROOM_ORIGIN, images.loader);
    const [early, late] = [images.requests.slice(0, 4), images.requests.slice(4)];
    const earlyTextures = early.map(() => new Texture());
    const spies = earlyTextures.map((texture) => vi.spyOn(texture, 'dispose'));
    early.forEach((request, index) => request.resolve(earlyTextures[index]!));
    await settle();
    const materials = postersIn(room.group).map((poster) => vi.spyOn(poster.material, 'dispose'));
    const geometries = postersIn(room.group).map((poster) => vi.spyOn(poster.geometry, 'dispose'));
    const boardsBefore = signs.mock.calls.length;
    room.dispose();
    room.dispose();
    for (const spy of [...spies, ...materials, ...geometries]) expect(spy).toHaveBeenCalledTimes(1);
    // Art still in flight when the room goes is released the moment it lands,
    // and a failure then makes no board for a room that no longer exists.
    const lateTexture = new Texture();
    const lateSpy = vi.spyOn(lateTexture, 'dispose');
    late[0]!.resolve(lateTexture);
    late[1]!.reject(new Error('gone'));
    await settle();
    expect(lateSpy).toHaveBeenCalledTimes(1);
    expect(signs).toHaveBeenCalledTimes(boardsBefore);
    expect(room.group.children).toHaveLength(0);
  });

  it('marks every lift with a pad, a label naming where it goes and, on the north wall, doors', () => {
    const cases = [
      { map: createFixedRoom(FIXED_ROOM_DEFINITIONS.exchange), labels: ['\u25b2 DEGEN FLOOR'] },
      { map: degenMap, labels: ['\u25bc GROUND FLOOR', '\u25b2 ROOF'] },
    ];
    for (const { map, labels } of cases) {
      const room = buildFixedRoom(map, createNullLabelFactory());
      room.group.updateMatrixWorld(true);
      const found = labelsIn(room.group, 'lift');
      expect(found.map((label) => label.userData['text'])).toEqual(labels);
      map.lifts.forEach((lift, index) => {
        const position = found[index]!.getWorldPosition(new Vector3());
        expect(position.x).toBeCloseTo(OX + lift.x + lift.width / 2);
        expect(position.z).toBeCloseTo(OZ + lift.y + lift.height / 2);
        expect(position.y).toBeGreaterThan(1.8);
        expect(found[index]!.userData['lift']).toBe(lift.to);
        // The pad is lit on the floor, flat.
        const glow = meshNamed(room.group, ':floor-glow');
        const flat = verticesIn(glow, OX + lift.x + 0.1, OZ + lift.y + 0.1, OX + lift.x + lift.width - 0.1, OZ + lift.y + lift.height - 0.1);
        expect(flat.length).toBeGreaterThan(0);
        expect(Math.max(...flat.map((vertex) => vertex.y))).toBeLessThan(0.02);
        // A pad against the north wall has doors standing in it, lit down the middle.
        if (lift.y === 1) {
          const north = meshNamed(room.group, ':wall-north:body');
          const doors = verticesIn(north, OX + lift.x + 0.15, OZ + 0.5, OX + lift.x + lift.width - 0.15, OZ + 0.7);
          expect(Math.max(...doors.map((vertex) => vertex.y))).toBeGreaterThan(1.75);
        }
      });
      room.dispose();
    }
  });

  it.each(FLOORS)('keeps the $building $level room within its draw-call budget', async (map) => {
    const room = buildFixedRoom(map, createNullLabelFactory());
    expect(drawCalls(room.group)).toBeLessThan(40);
    room.dispose();
    // With poster art loading, then loaded, it spends the same.
    const images = deferredImages();
    const loading = buildFixedRoom(map, createNullLabelFactory(), ROOM_ORIGIN, images.loader);
    expect(drawCalls(loading.group)).toBeLessThan(40);
    for (const request of images.requests) request.resolve(new Texture());
    await settle();
    expect(drawCalls(loading.group)).toBeLessThan(40);
    loading.dispose();
  });

  it.each([BANK_ROOM_DEFINITION, VAULT_ROOM_DEFINITION])('shares the $building counters\' desks and halos, so each extra counter costs only its own state (D-103)', (definition) => {
    const one = buildFixedRoom(createFixedRoom({ ...definition, stations: [definition.stations[0]!] }), createNullLabelFactory());
    const four = buildFixedRoom(createFixedRoom(definition), createNullLabelFactory());
    expect(definition.stations).toHaveLength(4);
    // One desk mesh, one screen mesh and one halo mesh for the whole row.
    for (const suffix of [':counters', ':counter-screens', ':halos']) {
      const found: string[] = [];
      four.group.traverse((object) => object instanceof Mesh && object.name.endsWith(suffix) && found.push(object.name));
      expect(found).toEqual([`room:${definition.building}${suffix}`]);
    }
    // Each counter beyond the first adds its status panel, beacon, label and
    // at most one brand plate, and the room stays inside its budget.
    const extra = drawCalls(four.group) - drawCalls(one.group);
    expect(extra).toBeLessThanOrEqual(3 * 4);
    expect(drawCalls(four.group)).toBeLessThan(40);
    one.dispose();
    four.dispose();
  });

  it('disposes the Degen floor completely: every poster, sign and lift label once', () => {
    const room = buildFixedRoom(degenMap, createNullLabelFactory());
    const labels: Object3D[] = [];
    room.group.traverse((object) => {
      if (object.userData['kind']) labels.push(object);
    });
    expect(labels.length).toBe(DEGEN_TOKENS.length + 1 + degenMap.lifts.length + degenMap.stations.length);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    room.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      materials.add(object.material as Material);
    });
    const spies = [...geometries, ...materials].map((value) => vi.spyOn(value, 'dispose'));
    room.dispose();
    room.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    for (const label of labels) expect(label.userData['disposed']).toBe(true);
  });
});

/** World-space vertices of a mesh inside an x/z rectangle. */
function verticesIn(mesh: Mesh, x0: number, z0: number, x1: number, z1: number): Vector3[] {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const found: Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    const vertex = new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (vertex.x >= x0 && vertex.x <= x1 && vertex.z >= z0 && vertex.z <= z1) found.push(vertex);
  }
  return found;
}

/** sRGB hexes of a mesh's vertex colours. */
function coloursOf(mesh: Mesh): number[] {
  const attribute = mesh.geometry.getAttribute('color');
  const colour = new Color();
  const found = new Set<number>();
  for (let i = 0; attribute && i < attribute.count; i++) {
    found.add(colour.setRGB(attribute.getX(i), attribute.getY(i), attribute.getZ(i)).getHex());
  }
  return [...found];
}

interface Hue {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** See street-builder.test.ts: perceptual hues of vertex colours and live emissives. */
function huesOf(root: Object3D): Hue[] {
  const found: Hue[] = [];
  const colour = new Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const push = (value: Color): void => {
    value.getHSL(hsl, SRGBColorSpace);
    found.push({ h: hsl.h * 360, s: hsl.s, l: hsl.l });
  };
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const attribute = object.geometry.getAttribute('color');
    for (let i = 0; attribute && i < attribute.count; i++) {
      push(colour.setRGB(attribute.getX(i), attribute.getY(i), attribute.getZ(i)));
    }
    const material = object.material as Partial<MeshStandardMaterial>;
    if (material.emissive && (material.emissiveIntensity ?? 0) > 0) push(colour.copy(material.emissive));
  });
  return found;
}

const isOrange = ({ h, s, l }: Hue): boolean => s > 0.5 && l > 0.15 && h >= 10 && h <= 40;
const isGreen = ({ h, s, l }: Hue): boolean => s > 0.5 && l > 0.15 && h >= 135 && h <= 175;

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
