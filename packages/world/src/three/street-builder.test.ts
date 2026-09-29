import { describe, expect, it, vi } from 'vitest';
import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  Color,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { SANDBOX_AREA, SANDBOX_ENTRANCE } from '@strkworld/shared';
import { createStreetMap, isSolidAt, type DistrictMap, type TileKind } from '../map/street.js';
import { EXCHANGE_ROOF_HEIGHT, EXCHANGE_ROOF_LEVEL, createFixedRoomLevel } from '../fixed-room.js';
import { createNullLabelFactory } from './labels.js';
import { CAMERA_FOV, createCameraRig } from './camera-rig.js';
import { AVNU, NEAR, STRK20, boxGeometry } from './palette.js';
import {
  PAVEMENT_HEIGHT,
  SANDBOX_GATE_TEXT,
  SANDBOX_SIGN_TEXT,
  buildStreet,
  streetSurfaceHeightAt,
  type BuildingOccluder,
  type GateOccluder,
  type StreetOccluder,
} from './street-builder.js';
import type { StreetView } from './types.js';

const PLAN = [
  { building: 'bank', x: 3 },
  { building: 'exchange', x: 12 },
  { building: 'post-office', x: 21 },
  { building: 'bridge', x: 30 },
  { building: 'vault', x: 39 },
] as const;

/** The gap in the sandbox wall: its column, and the open rows [z0, z1). */
const GATE = {
  x: SANDBOX_AREA.x - 1,
  z0: SANDBOX_ENTRANCE.y,
  z1: SANDBOX_ENTRANCE.y + SANDBOX_ENTRANCE.height,
} as const;
/** A tall avatar (2.05) holding a block overhead must pass under the lintel. */
const GATE_CLEARANCE = 3.4;

function build(map: DistrictMap = createStreetMap()): { map: DistrictMap; view: StreetView } {
  return { map, view: buildStreet(map, createNullLabelFactory()) };
}

describe('buildStreet', () => {
  it('splits the district into ground, door and label groups', () => {
    const { view } = build();
    expect(view.ground.children.length).toBeGreaterThan(0);
    expect(view.doors.children).toHaveLength(5);
    // Five facade signs, four brand plates, the sandbox square's sign and its
    // gate's, and the label on the Exchange tower's roof lift; then the Privacy
    // Plaza's (D-076): its gateway sign, the monument's three faces, the
    // table's card and the two E prompts.
    expect(view.labels.children).toHaveLength(19);
    expect(view.labels.children.filter((child) => child.userData['area'] === 'plaza')).toHaveLength(7);
    const names = view.ground.children.map((child) => child.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'street:grass',
        'street:road',
        'street:pavement',
        'street:markings',
        'street:sandbox-floor',
      ]),
    );
    view.dispose();
  });

  it('gives each building one occluder whose bounds match its solid footprint', () => {
    const { map, view } = build();
    const occluders = buildingOccluders(view);
    expect(occluders).toHaveLength(PLAN.length);
    for (const { building, x } of PLAN) {
      const occluder = occluders.find((candidate) => candidate.building === building);
      expect(occluder, building).toBeDefined();
      expect(occluder!.bounds).toMatchObject({ minX: x, maxX: x + 7, minZ: 5, maxZ: 11 });
      if (building === 'exchange') {
        // The tower's box stops at its roof deck: nothing on the roof hides anyone.
        expect(occluder!.bounds.height).toBe(EXCHANGE_ROOF_HEIGHT);
        continue;
      }
      expect(occluder!.bounds.height).toBeGreaterThanOrEqual(3.5);
      expect(occluder!.bounds.height).toBeLessThanOrEqual(8);
    }
    // Every building tile belongs to exactly one occluder footprint.
    const buildingTiles = [...tilesOf(map, 'wall'), ...tilesOf(map, 'facade')];
    expect(buildingTiles.length).toBeGreaterThan(0);
    for (const [x, y] of buildingTiles) {
      expect(ownersOf(occluders, x, y), `tile ${x},${y}`).toHaveLength(1);
    }
    view.dispose();
  });

  it('builds the sandbox wall as decor: fence tiles are not building footprints', () => {
    const { map, view } = build();
    const occluders = view.occluders as readonly StreetOccluder[];
    const pillars = new Set([GATE.z0 - 1, GATE.z1]);
    const fence = tilesOf(map, 'fence');
    expect(fence.length).toBeGreaterThan(0);
    for (const [x, y] of fence) {
      expect(isSolidAt(map, x, y)).toBe(true);
      expect(ownersOf(buildingOccluders(view), x, y), `fence ${x},${y}`).toHaveLength(0);
      // Only the gate's pillars carry anything that fades: its superstructure.
      const owners = ownersOf(occluders, x, y).map((occluder) => occluder.kind);
      expect(owners, `fence ${x},${y}`).toEqual(x === GATE.x && pillars.has(y) ? ['sandbox-gate'] : []);
    }
    const buildings = view.ground.children.filter((child) => child.name.startsWith('building:'));
    expect(buildings).toHaveLength(PLAN.length);
    for (const group of buildings) expect(group.userData['building']).not.toBeNull();
    view.dispose();
  });

  it('walls the square in toy blocks two high, open at the gate', () => {
    const { map, view } = build();
    const decor = meshNamed(view.ground, 'street:decor');
    const pillars = new Set([GATE.z0 - 1, GATE.z1]);
    for (const [x, y] of tilesOf(map, 'fence')) {
      const column = verticesIn(decor, x + 0.02, y + 0.02, x + 0.98, y + 0.98);
      // A stack standing on the tile: from the ground to its top block.
      expect(Math.min(...column.map((v) => v.y)), `fence ${x},${y}`).toBeLessThan(0.01);
      const top = Math.max(...column.map((v) => v.y));
      if (x === GATE.x && pillars.has(y)) continue;
      expect(top, `fence ${x},${y}`).toBeGreaterThan(1.95);
      expect(top, `fence ${x},${y}`).toBeLessThan(2.05);
    }
    // The map's gap is where these tests expect it.
    for (let z = GATE.z0; z < GATE.z1; z++) expect(isSolidAt(map, GATE.x, z), `gate row ${z}`).toBe(false);
    // Nothing stands or hangs in the opening, or just either side of it, below
    // the lintel's clearance.
    const opening = (x: number, z: number) => x >= GATE.x - 0.2 && x < GATE.x + 1.2 && z >= GATE.z0 && z < GATE.z1;
    expect(findWalkableIntrusions(view.ground, opening, map, { maxY: GATE_CLEARANCE })).toEqual([]);
    view.dispose();
  });

  it('frames the gate with pillars carrying a lintel that clears a tall avatar holding a block', () => {
    const { view } = build();
    const parts = [meshNamed(view.ground, 'street:decor'), meshNamed(view.ground, 'street:sandbox-gate')];
    const heights = (x0: number, z0: number, x1: number, z1: number) =>
      parts.flatMap((mesh) => verticesIn(mesh, x0, z0, x1, z1)).map((vertex) => vertex.y);
    // The pillars flank the opening, about four blocks tall, over two-high wall.
    for (const [pillar, wall] of [
      [GATE.z0 - 1, GATE.z0 - 2],
      [GATE.z1, GATE.z1 + 1],
    ] as const) {
      expect(Math.max(...heights(GATE.x + 0.02, pillar + 0.02, GATE.x + 0.98, pillar + 0.98))).toBeGreaterThan(3.95);
      expect(Math.max(...heights(GATE.x + 0.02, wall + 0.02, GATE.x + 0.98, wall + 0.98))).toBeLessThan(2.05);
    }
    // The lintel spans the opening; its underside is the lowest thing over it.
    const over = heights(GATE.x + 0.02, GATE.z0 + 0.02, GATE.x + 0.98, GATE.z1 - 0.02);
    expect(over.length).toBeGreaterThan(0);
    expect(Math.min(...over)).toBeGreaterThanOrEqual(GATE_CLEARANCE);
    expect(Math.min(...over)).toBeLessThan(4.5);
    expect(Math.max(...over)).toBeGreaterThan(4.9);
    view.dispose();
  });

  it('fades the gate superstructure as one occluder of its own, never the wall', () => {
    const { view } = build();
    const occluders = view.occluders as readonly StreetOccluder[];
    const gates = occluders.filter((occluder): occluder is GateOccluder => occluder.kind === 'sandbox-gate');
    expect(gates).toHaveLength(1);
    // Beside the Privacy Plaza's monument and gateway (D-076, plaza-builder.test.ts).
    expect(occluders.filter((occluder) => occluder.kind !== 'plaza')).toHaveLength(PLAN.length + 1);
    const gate = gates[0]!;
    const mesh = meshNamed(view.ground, 'street:sandbox-gate');
    expect(gate.object).toBe(mesh);
    // In the fading mesh: only what rises above the two-high wall...
    const box = new Box3().setFromObject(mesh);
    expect(box.min.y).toBeGreaterThan(2 - 1e-3);
    // ...and the occluder's box covers all of it: pillar tops, lintel, caps.
    expect(gate.bounds.minX).toBeLessThanOrEqual(Math.min(box.min.x, GATE.x));
    expect(gate.bounds.maxX).toBeGreaterThanOrEqual(Math.max(box.max.x, GATE.x + 1));
    expect(gate.bounds.minZ).toBeLessThanOrEqual(Math.min(box.min.z, GATE.z0 - 1));
    expect(gate.bounds.maxZ).toBeGreaterThanOrEqual(Math.max(box.max.z, GATE.z1 + 1));
    expect(gate.bounds.height).toBeGreaterThanOrEqual(box.max.y);
    expect(gate.bounds.maxX - gate.bounds.minX).toBeLessThan(1.2);
    // Its floor is the superstructure's base, so a sight line under the lintel
    // is clear; buildings still stand on the ground.
    expect(gate.bounds.minY).toBeCloseTo(box.min.y);
    expect(gate.bounds.minY).toBeCloseTo(2, 2);
    for (const building of buildingOccluders(view)) expect(building.bounds.minY ?? 0).toBe(0);
    // Solid in three boxes sharing the one fader: each pillar's top from the
    // wall's height, and the lintel with its caps from its underside, so the
    // gap between them is not.
    expect(gate.boxes).toHaveLength(3);
    const [north, south, lintel] = gate.boxes!;
    expect(north).toMatchObject({ minX: GATE.x, maxX: GATE.x + 1, minZ: GATE.z0 - 1, maxZ: GATE.z0, minY: 2, height: 4 });
    expect(south).toMatchObject({ minX: GATE.x, maxX: GATE.x + 1, minZ: GATE.z1, maxZ: GATE.z1 + 1, minY: 2, height: 4 });
    expect(lintel).toMatchObject({ minY: 4, height: gate.bounds.height });
    expect(lintel!.minZ).toBeCloseTo(gate.bounds.minZ);
    expect(lintel!.maxZ).toBeCloseTo(gate.bounds.maxZ);
    // The wall stays in the decor, nothing of it above two blocks at the gate.
    const decor = meshNamed(view.ground, 'street:decor');
    const wall = verticesIn(decor, GATE.x - 0.2, GATE.z0 - 3, GATE.x + 1.2, GATE.z1 + 3);
    expect(wall.length).toBeGreaterThan(0);
    expect(Math.max(...wall.map((vertex) => vertex.y))).toBeLessThan(2 + 1e-3);
    // Fading touches the gate's material alone, and restores it exactly.
    const own = materialsOf(mesh);
    const others = [decor, ...buildingOccluders(view).map((building) => building.object)].flatMap(materialsOf);
    for (const material of own) expect(others).not.toContain(material);
    const before = own.map(({ opacity, transparent, depthWrite }) => ({ opacity, transparent, depthWrite }));
    gate.setOpacity(0.25);
    for (const material of own) {
      expect(material.opacity).toBeCloseTo(0.25);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
    for (const material of others) expect(material.opacity).toBe(1);
    gate.setOpacity(1);
    expect(own.map(({ opacity, transparent, depthWrite }) => ({ opacity, transparent, depthWrite }))).toEqual(before);
    view.dispose();
  });

  it('hangs the gate sign over the opening on the lintel, facing the street', () => {
    const { view } = build();
    const sign = view.labels.children.find((child) => child.userData['area'] === 'sandbox-gate');
    expect(sign).toBeDefined();
    expect(sign!.userData['text']).toBe(SANDBOX_GATE_TEXT);
    expect(sign!.userData['kind']).toBe('sign');
    // A sign faces +Z at rotation 0; this one must face -X, west to the street.
    const facing = new Vector3(0, 0, 1).applyEuler(sign!.rotation);
    expect(facing.x).toBeCloseTo(-1);
    expect(facing.z).toBeCloseTo(0);
    expect(sign!.position.z).toBeCloseTo((GATE.z0 + GATE.z1) / 2);
    // On the lintel's street face, just proud of it.
    expect(sign!.position.x).toBeLessThan(GATE.x);
    expect(sign!.position.x).toBeGreaterThan(GATE.x - 0.1);
    const { width, height } = sign!.userData['options'] as { width: number; height: number };
    expect(sign!.position.y - height / 2).toBeGreaterThan(GATE_CLEARANCE);
    expect(width).toBeLessThan(GATE.z1 - GATE.z0);
    // The north-hedge board stays as it was.
    expect(view.labels.children.filter((child) => child.userData['area'] === 'sandbox')).toHaveLength(1);
    view.dispose();
  });

  it('finishes the street at the gate on a flat stone threshold at road level', () => {
    const { map, view } = build();
    for (let z = GATE.z0; z < GATE.z1; z++) expect(streetSurfaceHeightAt(map, GATE.x, z), `gate row ${z}`).toBe(0);
    // The pavements stay raised up to the gate, where they meet it at a flush kerb.
    expect(streetSurfaceHeightAt(map, GATE.x - 1, GATE.z0)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, GATE.x - 1, GATE.z1 - 1)).toBe(PAVEMENT_HEIGHT);
    const pavement = meshNamed(view.ground, 'street:pavement');
    const threshold = verticesIn(pavement, GATE.x + 0.01, GATE.z0 + 0.01, GATE.x + 0.99, GATE.z1 - 0.01);
    expect(threshold.length).toBeGreaterThan(0);
    expect(Math.max(...threshold.map((vertex) => vertex.y))).toBeLessThan(0.02);
    const kerb = verticesIn(pavement, GATE.x - 0.2, GATE.z0 + 0.01, GATE.x - 0.01, GATE.z1 - 0.01);
    expect(Math.max(...kerb.map((vertex) => vertex.y))).toBeLessThanOrEqual(PAVEMENT_HEIGHT + 0.005);
    // The road stops on the threshold: no asphalt or paint on the gate tiles.
    expect(verticesIn(meshNamed(view.ground, 'street:road'), GATE.x + 0.01, GATE.z0, GATE.x + 0.99, GATE.z1)).toEqual([]);
    const paint = new Box3().setFromObject(meshNamed(view.ground, 'street:markings'));
    expect(paint.max.x).toBeLessThanOrEqual(GATE.x + 1e-6);
    view.dispose();
  });

  it('marks the entrance apron inside the gate, flat on the build plate', () => {
    const { view } = build();
    const floor = meshNamed(view.ground, 'street:sandbox-floor');
    const { x, y, width, height } = SANDBOX_ENTRANCE;
    const apron = verticesIn(floor, x + 0.01, y + 0.01, x + width - 0.01, y + height - 0.01);
    expect(apron.length).toBeGreaterThan(0);
    expect(Math.max(...apron.map((vertex) => vertex.y))).toBeLessThan(0.02);
    // Its tones are its own: a plain stretch of plate the same size shares none of them.
    const plain = coloursIn(floor, x + 12, y + 0.01, x + 12 + width, y + height - 0.01);
    const marked = coloursIn(floor, x + 0.01, y + 0.01, x + width - 0.01, y + height - 0.01);
    expect(plain.size).toBeGreaterThan(0);
    expect([...marked].filter((colour) => !plain.has(colour)).length).toBeGreaterThan(0);
    view.dispose();
  });

  it('fades only the occluded building and restores its materials exactly', () => {
    const { view } = build();
    const occluders = buildingOccluders(view);
    const bank = occluders.find((occluder) => occluder.building === 'bank')!;
    const exchange = occluders.find((occluder) => occluder.building === 'exchange')!;
    const bankMaterials = materialsOf(bank.object);
    const exchangeMaterials = materialsOf(exchange.object);
    expect(bankMaterials.length).toBeGreaterThan(0);
    for (const material of bankMaterials) expect(exchangeMaterials).not.toContain(material);

    bank.setOpacity(0.3);
    for (const material of bankMaterials) {
      expect(material.opacity).toBeCloseTo(0.3);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
    for (const material of exchangeMaterials) {
      expect(material.opacity).toBe(1);
      expect(material.transparent).toBe(false);
    }

    bank.setOpacity(1);
    for (const material of bankMaterials) {
      expect(material.opacity).toBe(1);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }
    view.dispose();
  });

  it('positions a door portal over each door zone, the Vault marked locked', () => {
    const { map, view } = build();
    view.doors.updateMatrixWorld(true);
    for (const door of map.doors) {
      const portal = view.doors.children.find((child) => child.userData['building'] === door.building);
      expect(portal, door.building).toBeDefined();
      expect(portal!.position.x).toBeCloseTo(door.x + door.width / 2);
      expect(portal!.position.z).toBeGreaterThanOrEqual(door.y);
      expect(portal!.position.z).toBeLessThanOrEqual(door.y + door.height);
      expect(portal!.userData['locked']).toBe(door.locked);
      const box = new Box3().setFromObject(portal!);
      expect(box.min.x).toBeGreaterThanOrEqual(door.x - 0.5);
      expect(box.max.x).toBeLessThanOrEqual(door.x + door.width + 0.5);
      expect(box.min.z).toBeGreaterThanOrEqual(door.y - 0.05);
    }
    expect(map.doors.find((door) => door.building === 'vault')?.locked).toBe(true);
    view.dispose();
  });

  it('mounts a facade sign per exterior label above its door, facing the street', () => {
    const { map, view } = build();
    for (const exterior of map.exteriorLabels) {
      const sign = view.labels.children.find((child) => child.userData['text'] === exterior.text);
      expect(sign, exterior.text).toBeDefined();
      const plan = PLAN.find((entry) => entry.building === exterior.building)!;
      expect(sign!.position.x).toBeGreaterThan(plan.x);
      expect(sign!.position.x).toBeLessThan(plan.x + 7);
      expect(sign!.position.y).toBeGreaterThan(2.3);
      expect(sign!.position.y).toBeLessThan(4.2);
      expect(sign!.position.z).toBeGreaterThan(10.4);
      expect(sign!.position.z).toBeLessThanOrEqual(11.05);
      expect(sign!.rotation.y).toBe(0);
      expect(sign!.userData['kind']).toBe('sign');
      expect(sign!.userData['options']).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    }
    view.dispose();
  });

  it('lays the sandbox square as a flat build plate that the road runs into', () => {
    const { map, view } = build();
    view.ground.updateMatrixWorld(true);
    const plate = new Box3().setFromObject(meshNamed(view.ground, 'street:sandbox-floor'));
    expect(plate.min.x).toBeCloseTo(SANDBOX_AREA.x);
    expect(plate.max.x).toBeCloseTo(SANDBOX_AREA.x + SANDBOX_AREA.width);
    expect(plate.min.z).toBeCloseTo(SANDBOX_AREA.y);
    expect(plate.max.z).toBeCloseTo(SANDBOX_AREA.y + SANDBOX_AREA.height);
    expect(plate.max.y).toBeLessThan(0.02);
    // Road paint runs off the west edge but stops where the road meets the square.
    const paint = new Box3().setFromObject(meshNamed(view.ground, 'street:markings'));
    expect(paint.min.x).toBeLessThan(0);
    expect(paint.max.x).toBeLessThanOrEqual(SANDBOX_AREA.x + 1e-6);
    // The west end is closed by a barrier; the east end is open into the square.
    const boards = (x: number) => verticesNear(meshNamed(view.ground, 'street:decor'), (v) =>
      Math.abs(v.x - x) < 0.2 && v.z > 11 && v.z < 19 && v.y > 0.5 && v.y < 0.8,
    );
    expect(boards(-0.6)).toBeGreaterThan(0);
    expect(boards(map.width + 0.6)).toBe(0);
    view.dispose();
  });

  it('hangs the sandbox sign off the map above the north hedge, facing the street', () => {
    const { view } = build();
    const sign = view.labels.children.find((child) => child.userData['area'] === 'sandbox');
    expect(sign).toBeDefined();
    expect(sign!.userData['text']).toBe(SANDBOX_SIGN_TEXT);
    expect(sign!.position.z).toBeLessThan(0);
    expect(sign!.position.x).toBeGreaterThan(SANDBOX_AREA.x);
    expect(sign!.position.x).toBeLessThan(SANDBOX_AREA.x + SANDBOX_AREA.width);
    expect(sign!.position.y).toBeGreaterThan(1);
    expect(sign!.rotation.y).toBe(0);
    view.dispose();
  });

  it('names each protocol on its building in its own type, whole in the fixed camera', () => {
    const { map, view } = build();
    const plate = (building: string) => view.labels.children.find((child) => child.userData['brand'] === building);
    const expected = {
      bank: {
        text: 'STRK20',
        style: { titleFont: 'display', titleWeight: 900, uppercase: true, background: '#0d0d0d', accent: '#c53400', gradient: ['#fffdf1', '#f4ece8', '#ffcdb6'] },
      },
      exchange: { text: 'avnu', style: { lowercase: true, background: '#11131d', foreground: '#ffffff', accent: '#3761f6' } },
      bridge: {
        text: 'NEAR\nINTENTS',
        style: { titleWeight: 400, subtitleFont: 'mono', subtitleColor: '#00ec97', background: '#000000', foreground: '#ffffff', uppercase: true },
      },
      vault: { text: 'Vesu', style: { background: '#1d1e22', foreground: '#e0e5ff', accent: '#2c41f6' } },
    } as const;
    for (const [building, { text, style }] of Object.entries(expected)) {
      const sign = plate(building);
      expect(sign, building).toBeDefined();
      expect(sign!.userData['kind']).toBe('sign');
      expect(sign!.userData['text']).toBe(text);
      expect(sign!.userData['options']).toMatchObject(style);
      // On its own building's front, facing the street, above head height.
      const { x } = PLAN.find((entry) => entry.building === building)!;
      expect(sign!.position.x, building).toBeGreaterThan(x);
      expect(sign!.position.x, building).toBeLessThan(x + 7);
      expect(sign!.position.z, building).toBeGreaterThan(9.5);
      expect(sign!.position.z, building).toBeLessThanOrEqual(11.05);
      expect(sign!.position.y, building).toBeGreaterThan(2.3);
      expect(sign!.rotation.y).toBe(0);
      // Whole in the fixed camera's frame from the pavement in front of it.
      const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
      createCameraRig({ camera }).update(16, { x: sign!.position.x, z: 12 }, null);
      camera.updateMatrixWorld(true);
      const { width, height } = sign!.userData['options'] as { width: number; height: number };
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        const corner = new Vector3(sign!.position.x + (dx * width) / 2, sign!.position.y + (dy * height) / 2, sign!.position.z);
        const ndc = corner.project(camera);
        expect(Math.abs(ndc.x), building).toBeLessThan(1);
        expect(Math.abs(ndc.y), building).toBeLessThan(1);
      }
    }
    // The Post Office has no protocol plate, and every facade sign keeps its words.
    expect(plate('post-office')).toBeUndefined();
    for (const exterior of map.exteriorLabels) {
      expect(view.labels.children.filter((child) => child.userData['text'] === exterior.text)).toHaveLength(1);
    }
    const plates = view.labels.children.filter((child) => child.userData['brand']);
    view.dispose();
    for (const sign of plates) expect(sign.userData['disposed']).toBe(true);
  });

  it('dresses the Bank in STRK20, the Exchange in avnu and the Bridge in NEAR', () => {
    const { map, view } = build();
    const bank = view.ground.getObjectByName('building:bank')!;
    const exchange = view.ground.getObjectByName('building:exchange')!;
    const bridge = view.ground.getObjectByName('building:bridge')!;
    const emissive = (root: Object3D, suffix: string) =>
      (meshNamed(root, suffix).material as MeshStandardMaterial).emissive.getHex();
    expect(emissive(bank, ':glow')).toBe(new Color(STRK20.orange).getHex());
    expect(emissive(exchange, ':lit')).toBe(new Color(AVNU.blue).getHex());
    expect(emissive(bridge, ':glow')).toBe(new Color(NEAR.green).getHex());
    const portal = (building: string) =>
      view.doors.children.find((child) => child.userData['building'] === building)!;
    expect(emissive(portal('bank'), ':frame')).toBe(new Color(STRK20.orange).getHex());
    expect(emissive(portal('exchange'), ':frame')).toBe(new Color(AVNU.blue).getHex());
    expect(emissive(portal('bridge'), ':frame')).toBe(new Color(NEAR.green).getHex());
    const sign = (building: string) => view.labels.children.find((child) => child.userData['building'] === building)!;
    expect(sign('bank').userData['options']).toMatchObject({
      gradient: ['#fffdf1', '#f4ece8', '#ffcdb6'],
      titleFont: 'display',
      subtitleFont: 'mono',
      uppercase: true,
      background: '#141414',
    });
    expect(sign('exchange').userData['options']).toMatchObject({ background: '#1b1e2d', foreground: '#ffffff' });
    // NEAR: white on black, the Intents call to action in green uppercase mono, tight corners.
    expect(sign('bridge').userData['options']).toMatchObject({
      background: '#000000',
      foreground: '#ffffff',
      subtitleFont: 'mono',
      subtitleColor: '#00ec97',
      uppercase: true,
    });
    expect(sign('bridge').userData['options'].cornerRadius).toBeLessThanOrEqual(0.1);
    // Only the style changed: the words are still the map's.
    const exterior = map.exteriorLabels.find((label) => label.building === 'bridge')!;
    expect(sign('bridge').userData['text']).toBe(exterior.text);
    // The span's aurora is an additive wash that fades with the building.
    const aura = meshNamed(bridge, ':aura').material as Material;
    expect(aura.blending).toBe(AdditiveBlending);
    const bridgeOccluder = buildingOccluders(view).find((occluder) => occluder.building === 'bridge')!;
    bridgeOccluder.setOpacity(0.4);
    expect(aura.opacity).toBeCloseTo(0.4);
    bridgeOccluder.setOpacity(1);
    // Green leads and the Bank keeps orange: no orange on the Bridge, no green on the Bank.
    expect(huesOf(bridge).filter(isOrange)).toEqual([]);
    expect(huesOf(bridge).filter(isGreen).length).toBeGreaterThan(0);
    expect(huesOf(bank).filter(isGreen)).toEqual([]);
    view.dispose();
  });

  it('raises the Exchange as a tower whose roof is a walkable floor of the building', () => {
    const { map, view } = build();
    const H = EXCHANGE_ROOF_HEIGHT;
    const roof = createFixedRoomLevel(EXCHANGE_ROOF_LEVEL);
    const tower = view.ground.getObjectByName('building:exchange')!;
    tower.updateMatrixWorld(true);
    // The roof's grid lies exactly over the tower's street footprint.
    const exchange = buildingOccluders(view).find((occluder) => occluder.building === 'exchange')!;
    expect(roof.rooftop).toMatchObject({ x: exchange.bounds.minX, y: exchange.bounds.minZ });
    expect(roof.width).toBe(exchange.bounds.maxX - exchange.bounds.minX);
    expect(roof.height).toBe(exchange.bounds.maxZ - exchange.bounds.minZ);
    // Every street tile under it is the tower's: solid, or its door's alcove.
    const door = map.doors.find((candidate) => candidate.building === 'exchange')!;
    for (let y = 0; y < roof.height; y++) {
      for (let x = 0; x < roof.width; x++) {
        const [sx, sy] = [roof.rooftop!.x + x, roof.rooftop!.y + y];
        const inDoor = sx >= door.x && sx < door.x + door.width && sy >= door.y && sy < door.y + door.height;
        expect(isSolidAt(map, sx, sy) || inDoor, `street ${sx},${sy}`).toBe(true);
      }
    }
    // Glass up to the roof, and the old rooftop model on it.
    expect(new Box3().setFromObject(tower).max.y).toBeGreaterThan(H + 1);
    const glass = meshNamed(tower, ':glass');
    expect(glass.castShadow).toBe(true);
    expect(meshNamed(tower, ':ticker').position.y).toBeGreaterThan(H);
    expect(meshNamed(tower, ':podium-ticker').position.y).toBeLessThan(7);
    // A deck at exactly the roof's height over every walkable roof tile...
    const body = meshNamed(tower, ':body');
    const glow = meshNamed(tower, ':glow');
    const walkable = (x: number, z: number): boolean => {
      const tile = roof.tiles[Math.floor(z) - roof.rooftop!.y]?.[Math.floor(x) - roof.rooftop!.x];
      return tile === 'floor' || tile === 'lift';
    };
    // Looking straight down on a tile: the first solid thing under it.
    const raycaster = new Raycaster();
    const firstBelow = (x: number, z: number): number => {
      raycaster.set(new Vector3(x, H + 10, z), new Vector3(0, -1, 0));
      return raycaster.intersectObjects([body, glass], false)[0]?.point.y ?? -Infinity;
    };
    const front = exchange.bounds.maxZ - 0.45;
    for (let y = 0; y < roof.height; y++) {
      for (let x = 0; x < roof.width; x++) {
        const wx = roof.rooftop!.x + x + 0.5;
        const wz = Math.min(roof.rooftop!.y + y + 0.5, front - 0.05);
        if (walkable(wx, wz)) {
          // The deck, at exactly the roof's height the player stands at.
          expect(firstBelow(wx, wz), `deck ${x},${y}`).toBeGreaterThanOrEqual(H);
          expect(firstBelow(wx, wz), `deck ${x},${y}`).toBeLessThan(H + 0.02);
        } else {
          // The ring: a ledge knee-high at least, under a balustrade at the edge.
          expect(firstBelow(wx, wz), `ring ${x},${y}`).toBeGreaterThan(H + 0.4);
        }
      }
    }
    for (const [x, z] of [[exchange.bounds.minX + 0.12, 8], [exchange.bounds.maxX - 0.12, 8], [15.5, exchange.bounds.minZ + 0.12], [15.5, front - 0.02]] as const) {
      expect(firstBelow(x, z), `edge ${x},${z}`).toBeGreaterThan(H + 1.1);
    }
    // Nothing stands on the deck below head height, the lift pad included.
    const deck = (x: number, z: number) => walkable(x, z);
    expect(findWalkableIntrusions(tower, deck, map, { minY: H + 0.15, maxY: H + 1.9 })).toEqual([]);
    // The lift pad is lit on the deck, and labelled with where it goes.
    const pad = roof.lifts[0]!;
    const padX = roof.rooftop!.x + pad.x;
    const padZ = roof.rooftop!.y + pad.y;
    expect(verticesIn(glow, padX + 0.05, padZ + 0.05, padX + 0.95, padZ + 0.95).some((vertex) => Math.abs(vertex.y - H - 0.01) < 0.01)).toBe(true);
    const label = view.labels.children.find((child) => child.userData['lift'] === 'degen')!;
    expect(label.userData['text']).toBe('\u25bc DEGEN FLOOR');
    expect(label.position.toArray()).toEqual([padX + 0.5, H + 1.86, padZ + 0.5]);
    view.dispose();
  });

  it('has a roof intrusion check that catches a crate on the deck', () => {
    const map = createStreetMap();
    const H = EXCHANGE_ROOF_HEIGHT;
    const crate = new Object3D();
    const box = new Mesh(boxGeometry(14.3, H, 7.3, 14.7, H + 0.6, 7.7));
    box.name = 'crate';
    crate.add(box);
    const deck = (x: number, z: number) => x >= 13 && x < 18 && z >= 6 && z < 10;
    expect(findWalkableIntrusions(crate, deck, map, { minY: H + 0.15, maxY: H + 1.9 })).toEqual([expect.stringContaining('crate')]);
  });

  it('keeps every volume off walkable tiles below head height', () => {
    const { map, view } = build();
    const walkable = (x: number, z: number) => !isSolidAt(map, Math.floor(x), Math.floor(z));
    const found = [
      ...findWalkableIntrusions(view.ground, walkable, map),
      ...findWalkableIntrusions(view.doors, walkable, map),
    ];
    expect(found).toEqual([]);
    view.dispose();
  });

  it('has an intrusion check that catches a planted prop and allows a boundary-flush wall', () => {
    const map = createStreetMap();
    const walkable = (x: number, z: number) => !isSolidAt(map, Math.floor(x), Math.floor(z));
    const planted = new Object3D();
    const prop = new Mesh(boxGeometry(10.3, 0, 11.3, 10.7, 1, 11.7));
    prop.name = 'planted';
    planted.add(prop);
    expect(findWalkableIntrusions(planted, walkable, map)).toEqual([
      expect.stringContaining('planted'),
    ]);
    // The sandbox square is walkable ground too.
    const square = new Object3D();
    const block = new Mesh(boxGeometry(68.2, 0, 14.2, 68.8, 0.6, 14.8));
    block.name = 'block';
    square.add(block);
    expect(findWalkableIntrusions(square, walkable, map)).toEqual([expect.stringContaining('block')]);
    // An alcove side wall standing exactly on the solid/walkable boundary.
    const flush = new Object3D();
    flush.add(new Mesh(boxGeometry(4, 0, 9.8, 5, 2, 11)));
    expect(findWalkableIntrusions(flush, walkable, map)).toEqual([]);
  });

  it('stays under the draw-call budget', () => {
    const { map, view } = build();
    let calls = 0;
    for (const group of [view.ground, view.doors, view.labels]) {
      group.traverse((object) => {
        if (object instanceof Mesh || (object as { isSprite?: boolean }).isSprite) calls += 1;
      });
    }
    // The null labels are not meshes; a canvas sign costs one call each.
    calls += view.labels.children.length;
    void map;
    expect(calls).toBeLessThan(150);
    view.dispose();
  });

  it('animates door glow and the ticker deterministically', () => {
    const first = build().view;
    const second = build().view;
    const sample = (view: StreetView) => {
      const values: number[] = [];
      view.doors.traverse((object) => {
        if (object instanceof Mesh && object.material instanceof MeshStandardMaterial) {
          values.push(object.material.emissiveIntensity);
        }
      });
      view.ground.traverse((object) => {
        if (object instanceof Mesh && object.name.endsWith(':ticker')) {
          const map = (object.material as { map: Texture | null }).map;
          values.push(map?.offset.x ?? Number.NaN);
        }
      });
      return values;
    };
    const before = sample(first);
    for (const delta of [16, 33, 250, 999, 16]) {
      first.update(delta);
      second.update(delta);
    }
    expect(sample(first)).toEqual(sample(second));
    expect(sample(first)).not.toEqual(before);
    first.update(Number.NaN);
    first.update(-5);
    expect(sample(first)).toEqual(sample(second));
    first.dispose();
    second.dispose();
  });

  it('disposes every geometry, material, texture and instance buffer exactly once', () => {
    const { view } = build();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    const instanced = new Set<InstancedMesh>();
    for (const group of [view.ground, view.doors, view.labels]) {
      group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
        }
        if (object instanceof InstancedMesh) instanced.add(object);
      });
    }
    expect(geometries.size).toBeGreaterThan(20);
    expect(textures.size).toBeGreaterThan(0);
    const spies = [...geometries, ...materials, ...textures, ...instanced].map((value) =>
      vi.spyOn(value, 'dispose'),
    );
    const parent = new Object3D();
    parent.add(view.ground, view.doors, view.labels);

    view.dispose();
    view.dispose();

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
    expect(view.ground.children).toHaveLength(0);
    view.update(16);
  });

  it('reports raised pavement so the avatar can stand on the kerb', () => {
    const map = createStreetMap();
    expect(streetSurfaceHeightAt(map, 10, 11)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, 10, 18)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, 5, 10)).toBe(PAVEMENT_HEIGHT);
    expect(streetSurfaceHeightAt(map, 10, 14)).toBe(0);
    expect(streetSurfaceHeightAt(map, 5, 14)).toBe(0);
    expect(streetSurfaceHeightAt(map, 10, 2)).toBe(0);
    expect(streetSurfaceHeightAt(map, 23, 22)).toBe(0);
  });
});

function meshNamed(root: Object3D, suffix: string): Mesh {
  let found: Mesh | undefined;
  root.traverse((object) => {
    if (!found && object instanceof Mesh && object.name.endsWith(suffix)) found = object;
  });
  if (!found) throw new Error(`no mesh ${suffix}`);
  return found;
}

function verticesNear(mesh: Mesh, test: (vertex: Vector3) => boolean): number {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const vertex = new Vector3();
  let count = 0;
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (test(vertex)) count++;
  }
  return count;
}

function tilesOf(map: DistrictMap, kind: TileKind): [number, number][] {
  const tiles: [number, number][] = [];
  map.tiles.forEach((row, y) => row.forEach((tile, x) => tile === kind && tiles.push([x, y])));
  return tiles;
}

/** The street's occluders that fade a building; the gate's is not one. */
function buildingOccluders(view: StreetView): BuildingOccluder[] {
  return (view.occluders as readonly StreetOccluder[]).filter(
    (occluder): occluder is BuildingOccluder => occluder.kind === 'building',
  );
}

/** Occluders whose footprint holds the tile's centre. */
function ownersOf<T extends StreetOccluder>(occluders: readonly T[], x: number, y: number): T[] {
  const cx = x + 0.5;
  const cz = y + 0.5;
  return occluders.filter(({ bounds }) => cx > bounds.minX && cx < bounds.maxX && cz > bounds.minZ && cz < bounds.maxZ);
}

/** World-space vertices strictly inside an (x, z) rectangle, at any height. */
function verticesIn(mesh: Mesh, x0: number, z0: number, x1: number, z1: number): Vector3[] {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const found: Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    const vertex = new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (vertex.x > x0 && vertex.x < x1 && vertex.z > z0 && vertex.z < z1) found.push(vertex);
  }
  return found;
}

/** Distinct vertex colours inside an (x, z) rectangle. */
function coloursIn(mesh: Mesh, x0: number, z0: number, x1: number, z1: number): Set<string> {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const colour = mesh.geometry.getAttribute('color');
  const vertex = new Vector3();
  const found = new Set<string>();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (vertex.x > x0 && vertex.x < x1 && vertex.z > z0 && vertex.z < z1) {
      found.add([colour.getX(i), colour.getY(i), colour.getZ(i)].map((c) => c.toFixed(3)).join(','));
    }
  }
  return found;
}

interface Hue {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** Perceptual (sRGB) hue, saturation and lightness of every vertex colour and live emissive under `root`. */
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
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      found.add(material);
    }
  });
  return [...found];
}

/**
 * Sample every triangle between ankle and head height (or another band); a
 * sample is an intrusion when it sits more than a hair inside a walkable
 * tile. Tile boundaries (alcove walls, door faces) are allowed.
 */
function findWalkableIntrusions(
  root: Object3D,
  walkable: (x: number, z: number) => boolean,
  map: DistrictMap,
  band: { readonly minY?: number; readonly maxY?: number } = {},
): string[] {
  const MIN_Y = band.minY ?? 0.15;
  const MAX_Y = band.maxY ?? 1.9;
  const EPS = 0.04;
  const STEP = 0.12;
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
        const ia = index ? index.getX(t * 3) : t * 3;
        const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(position, ia).applyMatrix4(world);
        b.fromBufferAttribute(position, ib).applyMatrix4(world);
        c.fromBufferAttribute(position, ic).applyMatrix4(world);
        if (Math.max(a.y, b.y, c.y) < MIN_Y || Math.min(a.y, b.y, c.y) > MAX_Y) continue;
        if (Math.max(a.x, b.x, c.x) < 0 || Math.min(a.x, b.x, c.x) > map.width) continue;
        if (Math.max(a.z, b.z, c.z) < 0 || Math.min(a.z, b.z, c.z) > map.height) continue;
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
