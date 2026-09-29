import { describe, expect, it, vi } from 'vitest';
import {
  Box3,
  BufferGeometry,
  Color,
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
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import {
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_DEGEN_STATION,
  FIXED_ROOM_DEFINITIONS,
  VAULT_LENDING_STATION,
  VAULT_ROOM_DEFINITION,
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
  DEGEN_STATION_LOOKS,
  DEGEN_TOKENS,
  ENDUR,
  ENDUR_STATION_LOOKS,
  NEAR,
  ROOM_THEMES,
  STRK20,
  STRK20_STATION_LOOKS,
  VESU,
  VESU_STATION_LOOKS,
  roomTheme,
} from './palette.js';
import {
  DEGEN_POSTER_BOTTOM,
  DEGEN_POSTER_DEPTH,
  DEGEN_POSTER_SIZE,
  DEGEN_POSTER_SLOTS,
  DEGEN_SIGN_TEXT,
  INTERIOR_SOUTH_WALL_HEIGHT,
  INTERIOR_WALL_HEIGHT,
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

function floatingLabel(root: Object3D): Object3D {
  let found: Object3D | undefined;
  root.traverse((object) => {
    if (!found && object.userData['kind'] === 'floating') found = object;
  });
  if (!found) throw new Error('no floating label');
  return found;
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
    // The station label in NEAR's uppercase mono, white on black.
    expect(floatingLabel(group).userData['options']).toMatchObject({
      font: 'mono',
      uppercase: true,
      foreground: '#ffffff',
      background: 'rgba(0,0,0,0.9)',
    });
    // Locked until the Shell says otherwise, then green; the highlight's halo in the tint.
    const accent = meshNamed(group, ':status').material as MeshStandardMaterial;
    const halo = meshNamed(group, ':halo').material as MeshBasicMaterial;
    expect(accent.emissiveIntensity).toBe(0);
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null)));
    expect(accent.emissive.getHex()).toBe(new Color(NEAR.green).getHex());
    expect(halo.color.getHex()).toBe(new Color(NEAR.green).getHex());
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', 'bridge:deposit')));
    expect(halo.color.getHex()).toBe(new Color(NEAR.greenTint).getHex());
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

  it('dresses the Bank staking counter in Endur while the room and its shielding counter keep STRK20', () => {
    const { map, room } = build('bank');
    const staking = stationGroup(room, 'bank:staking');
    const shielding = stationGroup(room, 'bank:shielding');
    // Its own counter, on its own tiles east of shielding.
    room.group.updateMatrixWorld(true);
    const counter = new Box3().setFromObject(meshNamed(staking, ':counter'));
    expect(counter.min.x).toBeGreaterThanOrEqual(OX + 13);
    expect(counter.max.x).toBeLessThanOrEqual(OX + 15);
    expect(counter.min.z).toBeGreaterThanOrEqual(OZ + 3);
    expect(counter.max.z).toBeLessThanOrEqual(OZ + 4);
    // A light Endur kiosk (white top and card, mint field, green pill and
    // droplet, dark-green trim and wave), none of which reaches shielding.
    const endur = [ENDUR.card, ENDUR.band, ENDUR.green, ENDUR.greenDeep, ENDUR.dark].map((hex) => new Color(hex).getHex());
    const stakingColours = coloursOf(meshNamed(staking, ':counter'));
    for (const hex of endur) expect(stakingColours).toContain(hex);
    const shieldingColours = coloursOf(meshNamed(shielding, ':counter'));
    for (const hex of endur) expect(shieldingColours).not.toContain(hex);
    expect(counter.max.y).toBeGreaterThan(1.25);

    // Three distinct states in Endur's looks: locked is a calm grey.
    const accent = (group: Object3D) => meshNamed(group, ':status').material as MeshStandardMaterial;
    const halo = (group: Object3D) => meshNamed(group, ':halo').material as MeshBasicMaterial;
    const state = (group: Object3D) => ({
      colour: accent(group).color.getHex(),
      glow: accent(group).emissiveIntensity,
      halo: halo(group).color.getHex(),
      opacity: halo(group).opacity,
    });
    const show = (status: 'available' | 'locked', highlighted: 'bank:staking' | null, label = 'STAKE') =>
      room.setStations(
        fixedRoomStationPresentations(map, {
          ...roomState(map, status, highlighted),
          stations: [
            { station: 'bank:shielding', label: 'SHIELD / UNSHIELD', status },
            { station: 'bank:staking', label, status },
          ],
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

    // The counter costs five draw calls, and disposes with the room.
    const meshes: Mesh[] = [];
    staking.traverse((object) => object instanceof Mesh && meshes.push(object));
    expect(meshes).toHaveLength(5);
    const spies = [...new Set(meshes.flatMap((mesh) => [mesh.geometry, mesh.material as Material]))].map((value) =>
      vi.spyOn(value, 'dispose'),
    );
    room.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(endurPlate!.userData['disposed']).toBe(true);
  });

  it('dresses the opened Vault in Vesu (D-077): white pages, ink and one electric blue', () => {
    const theme = roomTheme('vault');
    expect(theme).toBe(ROOM_THEMES.vault);
    expect(theme).not.toBe(DEFAULT_ROOM_THEME);
    expect(theme).toMatchObject({
      decor: 'vesu',
      floorA: VESU.white,
      floorB: VESU.blueSoft,
      wall: VESU.white,
      wallLower: VESU.blueSoft,
      wallTop: VESU.ink,
      skirting: VESU.ink,
      trim: VESU.blue,
      kioskBase: VESU.blueSoft,
      kioskTop: VESU.white,
      exitGlow: VESU.blue,
      stationLooks: VESU_STATION_LOOKS,
    });
    const map = createFixedRoom(VAULT_ROOM_DEFINITION);
    const room = buildFixedRoom(map, createNullLabelFactory());
    expect(room.building).toBe('vault');
    expect(room.group.name).toBe('room:vault');
    // Its one counter, locked until the Shell opens it, under Vesu's pill label.
    const counter = stationGroup(room, VAULT_LENDING_STATION);
    expect(counter.userData['status']).toBe('locked');
    const label = floatingLabel(counter);
    expect(label.userData['text']).toBe('SUPPLY / REDEEM');
    expect(label.userData['options']).toMatchObject({
      font: 'sans',
      cornerRadius: 0.5,
      foreground: '#2030b6',
      background: 'rgba(224,229,255,0.96)',
      border: '#2c41f6',
    });
    // A light room: every walkable floor tile is Vesu's white or periwinkle.
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
    const halo = meshNamed(counter, ':halo').material as MeshBasicMaterial;
    accent.color.getHSL(hsl, SRGBColorSpace);
    expect(hsl.s).toBeLessThan(0.25);
    expect(accent.emissiveIntensity).toBe(0);
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', null)));
    expect(accent.emissive.getHex()).toBe(new Color(VESU.blue).getHex());
    expect(halo.color.getHex()).toBe(new Color(VESU.blue).getHex());
    const ready = { glow: accent.emissiveIntensity, halo: halo.opacity };
    room.setStations(fixedRoomStationPresentations(map, roomState(map, 'available', VAULT_LENDING_STATION)));
    expect(accent.emissiveIntensity).toBeGreaterThan(ready.glow);
    expect(halo.opacity).toBeGreaterThan(ready.halo);
    expect(halo.color.getHex()).toBe(new Color(VESU.blueText).getHex());
    // The lending card behind the counter, self-lit in Vesu's colours on the
    // north wall, and a small one on the counter. No word or figure anywhere
    // but the Shell's label.
    const north = (room.occluders as readonly InteriorOccluder[]).find((occluder) => occluder.side === 'north')!;
    const lights = coloursOf(meshNamed(north.object, ':lights'));
    for (const hex of [VESU.white, VESU.blueSoft, VESU.blue]) expect(lights).toContain(new Color(hex).getHex());
    const card = coloursOf(meshNamed(counter, ':screen'));
    for (const hex of [VESU.white, VESU.blue]) expect(card).toContain(new Color(hex).getHex());
    const labels: Object3D[] = [];
    room.group.traverse((object) => {
      if (object.userData['kind']) labels.push(object);
    });
    expect(labels).toEqual([label]);
    // Blue leads: nothing in the Bank's orange or the Bridge's and Endur's green.
    const hues = huesOf(room.group);
    expect(hues.filter(isOrange)).toEqual([]);
    expect(hues.filter(isGreen)).toEqual([]);
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
    expect(floatingLabel(counter).userData['text']).toBe('DEGEN SWAP');
    const accent = meshNamed(counter, ':status').material as MeshStandardMaterial;
    expect(accent.color.getHex()).toBe(new Color(DEGEN_STATION_LOOKS.locked.color).getHex());
    // Available and stepped up to: hot pink with a lime halo, and the Shell's label.
    room.setStations(fixedRoomStationPresentations(degenMap, roomState(degenMap, 'available', EXCHANGE_DEGEN_STATION, 'DEGEN')));
    expect(counter.userData['status']).toBe('available');
    expect(floatingLabel(counter).userData['text']).toBe('DEGEN');
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
