import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import {
  BUNKER_ELEVATOR_MESSAGE,
  BUNKER_ELEVATOR_STATION,
  BUNKER_ROOM_DEFINITION,
  createFixedRoom,
  fixedRoomStationPresentations,
  type FixedRoomLevelMap,
  type FixedRoomState,
} from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { createNullLabelFactory } from './labels.js';
import {
  NETCAFE_ELEVATOR_PROMPT,
  NETCAFE_GAME_TEXT,
  NETCAFE_OUT_OF_ORDER_SIGN,
  NETCAFE_RECEPTION_TEXT,
  NETCAFE_SIGN_TEXT,
  roomTheme,
} from './palette.js';
import { boothScreen, tubeLevel } from './bunker-room.js';
import { buildFixedRoom } from './room-builder.js';

/**
 * The hidden room's presentation (D-107): a net cafe left years ago, built
 * within the room budget, with no word that names the place, and a lift
 * whose only behaviour is to say it is out of order.
 */

const OX = ROOM_ORIGIN.x / 32;
const OZ = ROOM_ORIGIN.y / 32;
const map: FixedRoomLevelMap = createFixedRoom(BUNKER_ROOM_DEFINITION);

function build(reducedMotion?: () => boolean) {
  return buildFixedRoom(map, createNullLabelFactory(), ROOM_ORIGIN, null, reducedMotion ? { reducedMotion } : {});
}

function labelsIn(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  root.traverse((object) => {
    if (object.userData['kind'] === 'sign' || object.userData['kind'] === 'floating') found.push(object);
  });
  return found;
}

function state(highlighted: boolean, notice = false): FixedRoomState {
  return {
    inRoom: true,
    building: 'bunker',
    controlOwner: 'world',
    highlightedStation: highlighted ? BUNKER_ELEVATOR_STATION : null,
    noticeStation: notice ? BUNKER_ELEVATOR_STATION : null,
    stations: [{ station: BUNKER_ELEVATOR_STATION, label: map.stations[0]!.label, status: 'locked' }],
  };
}

describe('the hidden room\'s presentation (D-107)', () => {
  it('wears the net cafe theme', () => {
    expect(roomTheme('bunker').decor).toBe('netcafe');
  });

  it('says nothing that names the place: only generic words, the lift\'s paper and its line', () => {
    const room = build();
    const texts = labelsIn(room.group).map((label) => label.userData['text'] as string).sort();
    expect(texts).toEqual(
      [NETCAFE_SIGN_TEXT, NETCAFE_GAME_TEXT, NETCAFE_RECEPTION_TEXT, map.stations[0]!.label, BUNKER_ELEVATOR_MESSAGE].sort(),
    );
    for (const text of texts) expect(text).not.toMatch(/bunker|gaming|hideout|secret/i);
    // Japanese and katakana where a Tokyo net cafe would have them.
    expect(NETCAFE_SIGN_TEXT).toBe('ネットカフェ');
    expect(NETCAFE_GAME_TEXT).toBe('ゲーム');
    expect(map.stations[0]!.label).toBe('故障中\nOUT OF ORDER');
    room.dispose();
  });

  it('tapes the paper sign across the lift\'s doors and floats "Out of order" only after E there (D-117)', () => {
    const room = build();
    const group = room.group.getObjectByName(`station:${BUNKER_ELEVATOR_STATION}`)!;
    const labels = labelsIn(group);
    const paper = labels.find((label) => label.userData['station'] === BUNKER_ELEVATOR_STATION)!;
    expect(paper.userData['kind']).toBe('sign');
    expect(paper.userData['options']).toEqual(NETCAFE_OUT_OF_ORDER_SIGN);
    const prompt = labels.find((label) => label.userData['prompt'] === BUNKER_ELEVATOR_STATION)!;
    expect(prompt.userData['kind']).toBe('floating');
    expect(prompt.userData['text']).toBe(BUNKER_ELEVATOR_MESSAGE);
    expect(prompt.userData['options']).toEqual(NETCAFE_ELEVATOR_PROMPT);
    expect(prompt.visible).toBe(false);
    // Walking up only lights the counter; the shared "E · LIFT" prompt is the session's.
    room.setStations(fixedRoomStationPresentations(map, state(true)));
    expect(prompt.visible).toBe(false);
    expect(group.userData['highlighted']).toBe(true);
    room.setStations(fixedRoomStationPresentations(map, state(true, true)));
    expect(prompt.visible).toBe(true);
    expect(group.userData['status']).toBe('locked');
    room.setStations(fixedRoomStationPresentations(map, state(false)));
    expect(prompt.visible).toBe(false);
    // Over the doors, above head height.
    room.group.updateMatrixWorld(true);
    const at = prompt.getWorldPosition(paper.position.clone());
    const lift = map.stations[0]!;
    expect(at.x).toBeCloseTo(OX + lift.x + lift.width / 2);
    expect(at.y).toBeGreaterThan(2);
    room.dispose();
  });

  it('stays well inside the room budget, merged: forty calls at most, and here under twenty-five', () => {
    const room = build();
    let calls = 0;
    room.group.traverse((object) => {
      if (object instanceof Mesh || object.userData['kind']) calls += 1;
    });
    expect(calls).toBeLessThan(25);
    room.dispose();
  });

  it('leaves about half the monitors on, and the rest dark or cracked', () => {
    const screens = { on: 0, off: 0, cracked: 0 };
    for (const booth of map.fixtures.filter((fixture) => fixture.prop === 'pc-booth')) {
      for (let y = booth.y; y < booth.y + booth.height; y++) {
        for (let x = booth.x; x < booth.x + booth.width; x++) screens[boothScreen(x, y)] += 1;
      }
    }
    expect(screens.on).toBeGreaterThanOrEqual(8);
    expect(screens.off).toBeGreaterThanOrEqual(4);
    expect(screens.cracked).toBeGreaterThanOrEqual(2);
  });

  it('stutters one tube, and holds it steady for a player who asked for less motion', () => {
    const levels = new Set<number>();
    for (let t = 0; t < 5200; t += 50) levels.add(tubeLevel(t));
    expect(levels.size).toBeGreaterThan(2);
    for (const reduced of [false, true]) {
      const room = build(() => reduced);
      const tube = room.group.getObjectByName('room:bunker:tube') as Mesh;
      const light = room.group.getObjectByName('room:bunker:tube-light') as Mesh;
      const seen = new Set<number>();
      for (let k = 0; k < 40; k++) {
        room.update(130);
        seen.add(Math.round((light.material as MeshBasicMaterial).opacity * 100));
      }
      expect(tube.userData['flicker']).toBe(true);
      if (reduced) expect(seen.size).toBe(1);
      else expect(seen.size).toBeGreaterThan(1);
      room.dispose();
    }
  });

  it('builds the stair back up within the room\'s frame, and the booths on their fixtures', () => {
    const room = build();
    room.group.updateMatrixWorld(true);
    const floor = new Box3().setFromObject(room.group.getObjectByName('room:bunker:floor')!);
    expect(floor.max.z).toBeLessThanOrEqual(OZ + map.height + 1);
    // Every booth tile carries a desk-high volume.
    const mesh = room.group.getObjectByName('room:bunker:floor') as Mesh;
    const position = mesh.geometry.getAttribute('position');
    const high = new Set<string>();
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (y < 0.7) continue;
      high.add(`${Math.floor(position.getX(i) + 1e-4)},${Math.floor(position.getZ(i) + 1e-4)}`);
    }
    for (const booth of map.fixtures.filter((fixture) => fixture.prop === 'pc-booth')) {
      for (let y = booth.y; y < booth.y + booth.height; y++) {
        for (let x = booth.x; x < booth.x + booth.width; x++) expect(high.has(`${x},${y}`), `${x},${y}`).toBe(true);
      }
    }
    room.dispose();
  });
});
