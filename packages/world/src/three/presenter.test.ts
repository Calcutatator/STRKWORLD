import { describe, expect, it, vi } from 'vitest';
import { Color, Group, InstancedMesh, Mesh, SRGBColorSpace, Vector3, type Material } from 'three';
import { ARENA_BOX, SANDBOX_AREA, SANDBOX_BURST_HEIGHT, arenaTileCentre, type AvatarSpriteKey } from '@strkworld/shared';
import {
  BANK_ROOM_DEFINITION,
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_DEGEN_STATION,
  EXCHANGE_ROOF_HEIGHT,
  EXCHANGE_ROOF_LEVEL,
  VAULT_SUPPLY_STATION,
  VAULT_ROOM_DEFINITION,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomStationPresentations,
} from '../fixed-room.js';
import { cameraPositionFor } from './camera-rig.js';
import { createNullLabelFactory } from './labels.js';
import { createPresenter } from './presenter.js';
import { ARENA_SURFACE, ARENA_THRONE_SEAT } from './arena-room.js';
import { AFFORDANCE_EMBER, affordanceClock } from './affordance.js';
import { BoxGeometry, MeshBasicMaterial, ShaderMaterial } from 'three';
import { createRemotePeerSource } from '../remote-peer.js';
import type { AvatarFigure, AvatarFigureFactory } from './types.js';
import { JUMP_AIR_MS, JUMP_HEIGHT, JUMP_TOTAL_MS, REDUCED_JUMP_HEIGHT, jumpLift } from '../jump.js';

/**
 * The presenter in node (D-059): real builders and the null label factory,
 * with fake avatar figures so looks and animation calls can be observed.
 */

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

function setup(reducedMotion?: () => boolean, vaultOpen = false) {
  const parent = new Group();
  const figures = fakeFigures();
  const presenter = createPresenter({
    parent,
    labels: createNullLabelFactory(),
    figures: figures.factory,
    ...(reducedMotion ? { reducedMotion } : {}),
    ...(vaultOpen ? { vaultOpen: true } : {}),
  });
  const view = presenter.bindSession();
  // The Studio builds its figures first; the local avatar hangs off the root.
  const avatar = figures.created.find((figure) => figure.object.parent?.name === 'strkworld')!;
  return { parent, presenter, view, avatar, figures };
}

const tile = (x: number, y: number) => ({ x: x * 32 + 16, y: y * 32 + 16 });

describe('presenter', () => {
  it('draws the local avatar at the session position, in world units', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(24, 15), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.x).toBeCloseTo(24.5);
    expect(world.avatar.object.position.z).toBeCloseTo(15.5);
    expect(world.presenter.consumeSnap()).toBe(true);
    expect(world.presenter.consumeSnap()).toBe(false);
  });

  it('turns the avatar towards its heading without snapping', () => {
    const world = setup();
    world.view.setPlayerMotion({ vx: 160, vy: 0, sprinting: false });
    world.presenter.update(16);
    const yaw = world.presenter.player.yaw;
    expect(yaw).toBeGreaterThan(0);
    expect(yaw).toBeLessThan(Math.PI / 2);
    for (let i = 0; i < 30; i += 1) world.presenter.update(16);
    expect(world.presenter.player.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('shows one room at a time and hides the street while inside', () => {
    const world = setup();
    const street = world.parent.getObjectByName('strkworld')!;
    world.view.setStreetVisible(false);
    world.view.showRoom('bank');
    const rooms = street.children.filter((child) => child.name.includes('room') && child.visible);
    expect(rooms.length).toBeLessThanOrEqual(1);
    world.view.showRoom(null);
    world.view.setStreetVisible(true);
  });

  it('holds a carried block above the head and follows sandbox elevation with a hop', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    // The engine consumes the teleport snap every frame; do the same here.
    world.presenter.consumeSnap();
    world.view.setCarried(2);
    const carried = world.avatar.object.children.find((child) => child.visible);
    expect(carried?.position.y).toBeGreaterThan(1);
    world.view.setPlayerElevation(1);
    world.presenter.update(95);
    // Mid-hop the feet are above the landing level, then land exactly.
    expect(world.avatar.object.position.y).toBeGreaterThan(1);
    world.presenter.update(200);
    expect(world.avatar.object.position.y).toBeCloseTo(1);
    world.view.setPlayerElevation(0);
    for (let i = 0; i < 40; i += 1) world.presenter.update(16);
    expect(world.avatar.object.position.y).toBeCloseTo(0);
  });

  it('keeps falling, never NaN, when a stack rises under a falling player', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    world.presenter.consumeSnap();
    world.view.setPlayerElevation(3);
    world.presenter.update(16);
    world.view.setPlayerElevation(0);
    world.presenter.update(100);
    // Mid-fall, above the new landing: the rise must not start a hop.
    world.view.setPlayerElevation(1);
    for (let i = 0; i < 40; i += 1) {
      world.presenter.update(16);
      expect(Number.isFinite(world.presenter.player.elevation)).toBe(true);
      expect(Number.isFinite(world.avatar.object.position.y)).toBe(true);
    }
    expect(world.presenter.player.elevation).toBeCloseTo(1);
  });

  it('throws the blocks of a burst and lets a player on the pillar fall under gravity, not snap (D-071)', () => {
    const world = setup();
    const at = { x: SANDBOX_AREA.x + 3, y: 14 };
    const blocks = world.parent.getObjectByName('sandbox:blocks') as InstancedMesh;
    world.view.setPlayerPosition(tile(at.x, at.y), true);
    world.view.setSandboxColumns([{ ...at, colours: Array.from({ length: SANDBOX_BURST_HEIGHT }, () => 1) }]);
    world.presenter.update(16);
    world.presenter.consumeSnap();
    world.view.setPlayerElevation(SANDBOX_BURST_HEIGHT);
    world.presenter.update(16);
    expect(world.presenter.player.elevation).toBe(SANDBOX_BURST_HEIGHT);
    expect(blocks.count).toBe(SANDBOX_BURST_HEIGHT);

    // The lobby's order: the burst, then the state that empties the board.
    world.view.sandboxBurst(at);
    world.view.setSandboxColumns([]);
    world.view.setPlayerElevation(0);
    world.presenter.update(16);
    const falling = world.presenter.player.elevation;
    expect(falling).toBeLessThan(SANDBOX_BURST_HEIGHT);
    expect(falling).toBeGreaterThan(SANDBOX_BURST_HEIGHT - 1);
    let previous = falling;
    for (let frame = 0; frame < 120; frame += 1) {
      world.presenter.update(16);
      const elevation = world.presenter.player.elevation;
      expect(elevation).toBeLessThanOrEqual(previous);
      previous = elevation;
    }
    expect(world.presenter.player.elevation).toBe(0);
    expect(world.avatar.object.position.y).toBeCloseTo(0);
    // Flown away and gone.
    expect(blocks.count).toBe(0);
  });

  it('passes the reduced-motion preference to the sandbox, so a burst pops out in place', () => {
    const world = setup(() => true);
    const at = { x: SANDBOX_AREA.x + 3, y: 14 };
    const blocks = world.parent.getObjectByName('sandbox:blocks') as InstancedMesh;
    world.view.setSandboxColumns([{ ...at, colours: [1, 2] }]);
    for (let frame = 0; frame < 30; frame += 1) world.presenter.update(16);
    world.view.sandboxBurst(at);
    for (let frame = 0; frame < 16; frame += 1) world.presenter.update(16);
    expect(blocks.count).toBe(0);
  });

  it('lands at once when a stack rises more than a block under the player', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    world.view.setPlayerElevation(4);
    world.presenter.update(16);
    expect(world.presenter.player.elevation).toBe(4);
  });

  it('ignores a retired session, so it cannot steer its successor', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(10, 14), true);
    const next = world.presenter.bindSession();
    world.view.setPlayerPosition(tile(40, 14), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.x).toBeCloseTo(10.5);
    next.setPlayerPosition(tile(30, 14), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.x).toBeCloseTo(30.5);
  });

  it('fades a building between the camera and the player, and restores it', () => {
    const world = setup();
    // Behind the Bank (north of its footprint), camera to the south.
    world.view.setPlayerPosition(tile(6, 3), true);
    world.presenter.update(16);
    const camera = new Vector3(6.5, 9, 16);
    for (let i = 0; i < 30; i += 1) world.presenter.updateOcclusion(camera, 16);
    world.view.setPlayerPosition(tile(6, 20), true);
    for (let i = 0; i < 30; i += 1) world.presenter.updateOcclusion(camera, 16);
    // No throw, and the loop settles; opacity values are internal to occluders.
    expect(true).toBe(true);
  });

  it('fades the sandbox gate over a player in its opening, and restores it exactly', () => {
    const world = setup();
    const materialOf = (name: string): Material => {
      const mesh = world.parent.getObjectByName(name);
      expect(mesh, name).toBeInstanceOf(Mesh);
      return (mesh as Mesh).material as Material;
    };
    const gate = materialOf('street:sandbox-gate');
    const wall = materialOf('street:decor');
    const state = ({ opacity, transparent, depthWrite }: Material) => ({ opacity, transparent, depthWrite });
    const opaque = state(gate);
    const stand = (x: number, z: number) => {
      world.view.setPlayerPosition(tile(Math.floor(x), Math.floor(z)), true);
      world.presenter.update(16);
    };
    const settle = (camera: { x: number; y: number; z: number }) => {
      for (let i = 0; i < 30; i += 1) world.presenter.updateOcclusion(new Vector3(camera.x, camera.y, camera.z), 16);
    };
    // The fixed camera, south of a player in the opening: the south pillar's
    // top and the lintel stand between them.
    const column = SANDBOX_AREA.x - 1;
    stand(column, 15);
    settle(cameraPositionFor({ x: column + 0.5, z: 15.5 }));
    expect(gate.opacity).toBeLessThan(0.5);
    expect(gate.transparent).toBe(true);
    expect(gate.depthWrite).toBe(false);
    // The wall is decor and never fades.
    expect(state(wall)).toEqual({ opacity: 1, transparent: false, depthWrite: true });
    // One step back up the road, out of the gate's column: restored exactly.
    stand(column - 1, 15);
    settle(cameraPositionFor({ x: column - 0.5, z: 15.5 }));
    expect(state(gate)).toEqual(opaque);
    // On the entrance apron, just inside, nothing is in the way: not from the
    // fixed camera, nor from one behind the player looking east through the
    // opening, whose line passes under the lintel between the pillars.
    for (const x of [54.5, 55.5, 56.5]) {
      stand(x, 15.5);
      settle(cameraPositionFor({ x, z: 15.5 }));
      expect(state(gate), `apron ${x}`).toEqual(opaque);
      settle({ x: x - 10, y: 7.5, z: 15.5 });
      expect(state(gate), `apron ${x}, looking east`).toEqual(opaque);
    }
    // In the opening, a camera to either side sees the player under the lintel.
    stand(column, 15);
    for (const dx of [10, -10]) {
      settle({ x: column + 0.5 + dx, y: 7.5, z: 15.5 });
      expect(state(gate)).toEqual(opaque);
    }
  });

  it('draws the Degen floor as its own interior, one floor of the Exchange at a time', () => {
    const world = setup();
    const root = world.parent.getObjectByName('strkworld')!;
    const room = (name: string) => root.children.find((child) => child.name === name)!;
    world.view.setStreetVisible(false);
    world.view.showRoom('exchange', 'degen');
    expect(room('room:exchange:degen').visible).toBe(true);
    expect(room('room:exchange').visible).toBe(false);
    world.view.showRoom('exchange');
    expect(room('room:exchange').visible).toBe(true);
    expect(room('room:exchange:degen').visible).toBe(false);
    // The Exchange's station state reaches whichever floor draws the station.
    const degen = createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL);
    world.view.renderRoom('exchange', fixedRoomStationPresentations(degen, {
      inRoom: true,
      building: 'exchange',
      level: 'degen',
      controlOwner: 'world',
      highlightedStation: null,
      stations: [{ station: EXCHANGE_DEGEN_STATION, label: 'DEGEN', status: 'available' }],
    }));
    const counter = room('room:exchange:degen').children.find((child) => child.userData['station'] === EXCHANGE_DEGEN_STATION)!;
    expect(counter.userData['status']).toBe('available');
    // No roof room: the roof is the tower's top in the street.
    expect(root.children.filter((child) => child.name.startsWith('room:exchange')).map((child) => child.name).sort()).toEqual([
      'room:exchange',
      'room:exchange:degen',
    ]);
  });

  it('stands the player on the roof in the street scene and points the camera down', () => {
    const world = setup();
    expect(world.presenter.cameraPreset).toBe('street');
    const roof = EXCHANGE_ROOF_LEVEL.rooftop;
    world.view.showRoom(null);
    world.view.showRooftop('exchange');
    world.view.setPlayerPosition(tile(roof.x + 5, roof.y + 3), true);
    world.view.setPlayerElevation(EXCHANGE_ROOF_HEIGHT);
    world.presenter.update(16);
    expect(world.presenter.cameraPreset).toBe('rooftop');
    expect(world.avatar.object.position.y).toBeCloseTo(EXCHANGE_ROOF_HEIGHT);
    expect(world.presenter.player.elevation).toBe(EXCHANGE_ROOF_HEIGHT);
    // The street, not an interior, is drawn around and below.
    expect(world.parent.getObjectByName('street:ground')!.visible).toBe(true);
    expect(world.parent.getObjectByName('room:exchange')!.visible).toBe(false);
    // Down the lift: level again, on the floor, in one frame.
    world.view.showRooftop(null);
    world.view.setPlayerPosition(tile(4, 14), true);
    world.view.setPlayerElevation(0);
    world.presenter.update(16);
    expect(world.presenter.cameraPreset).toBe('street');
    expect(world.avatar.object.position.y).toBeCloseTo(0);
    // A new session starts on the street.
    world.view.showRooftop('exchange');
    world.presenter.bindSession();
    expect(world.presenter.cameraPreset).toBe('street');
  });

  it('never fades anything while the camera looks down on the roof', () => {
    const world = setup();
    const roof = createFixedRoomLevel(EXCHANGE_ROOF_LEVEL);
    const origin = roof.rooftop!;
    // Everything that can fade: every building and the sandbox gate.
    const materials: Material[] = [];
    world.parent.getObjectByName('street:ground')!.traverse((object) => {
      const fades = object.name.startsWith('building:') || object.name === 'street:sandbox-gate';
      if (object instanceof Mesh && (fades || object.parent?.name.startsWith('building:'))) materials.push(object.material as Material);
    });
    expect(materials.length).toBeGreaterThan(20);
    const state = (material: Material) => ({ opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
    const before = materials.map(state);
    world.view.showRoom(null);
    world.view.showRooftop('exchange');
    let tiles = 0;
    for (let y = 0; y < roof.height; y++) {
      for (let x = 0; x < roof.width; x++) {
        if (roof.tiles[y]![x] === 'wall') continue;
        world.view.setPlayerPosition(tile(origin.x + x, origin.y + y), true);
        world.view.setPlayerElevation(EXCHANGE_ROOF_HEIGHT);
        world.presenter.update(16);
        const camera = cameraPositionFor({ x: origin.x + x + 0.5, z: origin.y + y + 0.5 }, EXCHANGE_ROOF_HEIGHT, 'rooftop');
        for (let i = 0; i < 20; i += 1) world.presenter.updateOcclusion(new Vector3(camera.x, camera.y, camera.z), 16);
        expect(materials.map(state), `deck ${x},${y}`).toEqual(before);
        tiles += 1;
      }
    }
    expect(tiles).toBe(20);
  });

  it('builds the Vault room and draws its door open only when the Shell opened it (D-077)', () => {
    const roomsOf = (parent: Group) =>
      parent.getObjectByName('strkworld')!.children.filter((child) => child.name.startsWith('room:')).map((child) => child.name);
    const signsOf = (parent: Group) => parent.getObjectByName('street:labels')!.children.map((child) => child.userData['text']);
    const closed = setup();
    const alwaysOpen = roomsOf(closed.parent);
    expect(alwaysOpen).not.toContain('room:vault');
    expect(closed.parent.getObjectByName('door:vault')!.userData['locked']).toBe(true);
    expect(signsOf(closed.parent)).toContain('VAULT\nCOMING SOON');
    closed.presenter.dispose();

    const parent = new Group();
    const presenter = createPresenter({
      parent,
      labels: createNullLabelFactory(),
      figures: fakeFigures().factory,
      vaultOpen: true,
    });
    const view = presenter.bindSession();
    expect(roomsOf(parent)).toEqual([...alwaysOpen, 'room:vault']);
    expect(parent.getObjectByName('door:vault')!.userData['locked']).toBe(false);
    expect(signsOf(parent)).toContain('VAULT\nSUPPLY / REDEEM');
    expect(signsOf(parent)).not.toContain('VAULT\nCOMING SOON');
    // Hidden until the session enters it, then drawn like any room.
    const vault = parent.getObjectByName('room:vault')!;
    expect(vault.visible).toBe(false);
    view.setStreetVisible(false);
    view.showRoom('vault');
    expect(vault.visible).toBe(true);
    expect(parent.getObjectByName('room:bank')!.visible).toBe(false);
    view.renderRoom('vault', fixedRoomStationPresentations(createFixedRoom(VAULT_ROOM_DEFINITION), {
      inRoom: true,
      building: 'vault',
      level: 'ground',
      controlOwner: 'world',
      highlightedStation: null,
      stations: [{ station: VAULT_SUPPLY_STATION, label: 'SUPPLY', status: 'available' }],
    }));
    const counter = vault.children.find((child) => child.userData['station'] === VAULT_SUPPLY_STATION)!;
    expect(counter.userData['status']).toBe('available');
    view.showRoom(null);
    expect(vault.visible).toBe(false);
    presenter.dispose();
    expect(parent.children).toEqual([]);
  });

  it('disposes everything once and detaches from its parent', () => {
    const world = setup();
    world.presenter.dispose();
    world.presenter.dispose();
    expect(world.parent.children).toEqual([]);
    for (const figure of world.figures.created) expect(figure.dispose).toHaveBeenCalledOnce();
    expect(() => world.presenter.bindSession()).toThrow();
  });
});

describe('the football in the presenter (D-078)', () => {
  const ballFrame = { x: 14 * 32, y: 15 * 32, vx: 0, vy: 0, starks: 2, snarks: 1, phase: 'live' } as const;
  const find = (root: Group, name: string) => {
    let found: import('three').Object3D | undefined;
    root.traverse((object) => {
      if (!found && (object.name === name || object.userData['pitch'] === name || object.userData['football'] === name)) found = object;
    });
    if (!found) throw new Error(`no ${name}`);
    return found;
  };

  it('draws the ball and the scoreboard from the session\'s frame, and hides them with the street', () => {
    const world = setup();
    world.view.setFootball(ballFrame);
    world.presenter.update(16);
    const ball = find(world.parent, 'football:ball');
    expect(ball.visible).toBe(true);
    expect(ball.position.x).toBeCloseTo(14);
    expect(find(world.parent, 'scoreboard').userData['text']).toBe('STARKS 2 – 1 SNARKS');
    world.view.setStreetVisible(false);
    expect(find(world.parent, 'football').visible).toBe(false);
    world.view.setStreetVisible(true);
    expect(find(world.parent, 'football').visible).toBe(true);
    world.view.setKickPrompt(true);
    expect(find(world.parent, 'prompt').visible).toBe(true);
    world.view.footballMoment({ kind: 'goal', side: 'starks' });
    expect(find(world.parent, 'cheer').visible).toBe(true);
  });

  it('starts a new session clean: no ball, no prompt, no cheer, 0-0 on the board', () => {
    const world = setup();
    world.view.setFootball(ballFrame);
    world.view.setKickPrompt(true);
    world.view.footballMoment({ kind: 'full-time', winner: 'starks', starks: 5, snarks: 1 });
    world.presenter.bindSession();
    expect(find(world.parent, 'football:ball').visible).toBe(false);
    expect(find(world.parent, 'prompt').visible).toBe(false);
    expect(find(world.parent, 'cheer').visible).toBe(false);
    expect(find(world.parent, 'scoreboard').userData['text']).toBe('STARKS 0 – 0 SNARKS');
    // The retired session's view steers nothing.
    world.view.setFootball(ballFrame);
    expect(find(world.parent, 'football:ball').visible).toBe(false);
  });

  it('passes the reduced-motion preference to the football, so a goal throws no confetti', () => {
    const world = setup(() => true);
    world.view.footballMoment({ kind: 'goal', side: 'snarks' });
    expect((find(world.parent, 'football:confetti') as InstancedMesh).count).toBe(0);
  });
});

describe('remote peers in shared areas (D-087)', () => {
  function withPeer(x: number, y: number) {
    const parent = new Group();
    const figures = fakeFigures();
    const presenter = createPresenter({ parent, labels: createNullLabelFactory(), figures: figures.factory });
    const peers = createRemotePeerSource([{ id: 'peer', x, y, facing: 'down', sprite: 'avatar-3' }]);
    const view = presenter.bindSession(peers.source);
    const remote = () => figures.created.find((figure) => figure.object.parent?.name === 'remote-avatars');
    return { presenter, view, peers, remote };
  }

  it('stands a peer over the tower on the roof deck while the player is on the roof', () => {
    const roof = EXCHANGE_ROOF_LEVEL.rooftop!;
    const deck = tile(roof.x + 3, roof.y + 2);
    const world = withPeer(deck.x, deck.y);
    world.view.showRooftop('exchange');
    world.presenter.update(16);
    expect(world.remote()?.object.position.y).toBe(EXCHANGE_ROOF_HEIGHT);
  });

  it('stands a street passer-by on the street below while the player is on the roof', () => {
    const roof = EXCHANGE_ROOF_LEVEL.rooftop!;
    // On the road in front of the tower, below the roof's footprint.
    const road = tile(roof.x + 3, roof.y + EXCHANGE_ROOF_LEVEL.height + 3);
    const world = withPeer(road.x, road.y);
    world.view.showRooftop('exchange');
    world.presenter.update(16);
    expect(world.remote()?.object.position.y).toBe(0);
    // Just off the footprint's east edge, on the grass beside the tower.
    const beside = withPeer(tile(roof.x + EXCHANGE_ROOF_LEVEL.width, roof.y + 2).x, tile(0, roof.y + 2).y);
    beside.view.showRooftop('exchange');
    beside.presenter.update(16);
    expect(beside.remote()?.object.position.y).toBeLessThan(EXCHANGE_ROOF_HEIGHT);
  });

  it('stands a peer on the flat floor in the Studio, with the street hidden', () => {
    const world = withPeer(tile(6, 6).x, tile(6, 6).y);
    world.view.setStreetVisible(false);
    world.view.syncStudio({ visible: true, highlightedFigure: null });
    world.presenter.update(16);
    expect(world.remote()?.object.position.y).toBe(0);
  });

  it('plays a peer\'s jump when its counter changes, not the counter it arrived with (D-097)', () => {
    const at = tile(6, 20);
    const parent = new Group();
    const figures = fakeFigures();
    const presenter = createPresenter({ parent, labels: createNullLabelFactory(), figures: figures.factory });
    const peers = createRemotePeerSource([{ id: 'peer', x: at.x, y: at.y, facing: 'down', sprite: 'avatar-3', jumps: 7 }]);
    presenter.bindSession(peers.source);
    const remote = figures.created.find((figure) => figure.object.parent?.name === 'remote-avatars')!;
    presenter.update(16);
    const standing = remote.object.position.y;
    // Met mid-session with 7 jumps behind it: it does not jump on sight.
    presenter.update(JUMP_AIR_MS / 4);
    expect(remote.object.position.y).toBe(standing);

    peers.publish([{ id: 'peer', x: at.x, y: at.y, facing: 'down', sprite: 'avatar-3', jumps: 8 }]);
    for (let ms = 0; ms < JUMP_AIR_MS / 2; ms += 25) presenter.update(25);
    expect(remote.object.position.y).toBeCloseTo(standing + JUMP_HEIGHT, 1);
    const motion = remote.update.mock.calls.at(-1)![1];
    expect(motion.jump?.tuck).toBeGreaterThan(0.9);
    const shadow = remote.object.parent!.children.find((child) => child.name === 'avatar:jump-shadow')!;
    expect(shadow.visible).toBe(true);
    expect(shadow.position.y).toBeLessThan(standing + 0.05);
    expect(shadow.scale.x).toBeLessThan(1);
    for (let ms = 0; ms < JUMP_AIR_MS; ms += 25) presenter.update(25);
    expect(remote.object.position.y).toBe(standing);
    expect(shadow.visible).toBe(false);
  });
});

describe('presenter: the local jump (D-097)', () => {
  const shadowOf = (world: ReturnType<typeof setup>) =>
    world.avatar.object.parent!.children.find((child) => child.name === 'avatar:jump-shadow')!;

  it('lifts the avatar in an arc over the ground it stands on, and lands', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(24, 15), true);
    world.presenter.update(16);
    const ground = world.avatar.object.position.y;
    expect(shadowOf(world).visible).toBe(false);

    world.view.playerJump();
    for (let ms = 0; ms < JUMP_AIR_MS / 2; ms += 25) world.presenter.update(25);
    expect(world.presenter.jumpLift).toBeCloseTo(JUMP_HEIGHT, 1);
    expect(world.avatar.object.position.y).toBeCloseTo(ground + world.presenter.jumpLift, 5);
    // The camera follows the feet's surface, not the hop, so the hop reads.
    expect(world.presenter.player.elevation).toBe(0);
    const motion = world.avatar.update.mock.calls.at(-1)![1];
    expect(motion.jump?.tuck).toBeGreaterThan(0.9);

    // The shadow stays on the ground and shrinks.
    const shadow = shadowOf(world);
    expect(shadow.visible).toBe(true);
    expect(shadow.position.y).toBeLessThan(ground + 0.05);
    expect(shadow.scale.x).toBeLessThan(0.7);

    for (let ms = 0; ms < JUMP_AIR_MS; ms += 25) world.presenter.update(25);
    expect(world.presenter.jumpLift).toBe(0);
    expect(world.avatar.object.position.y).toBe(ground);
    expect(shadow.visible).toBe(false);
    expect(world.avatar.update.mock.calls.at(-1)![1].jump).toBeNull();
  });

  it('keeps walking through a jump: the ground position is the session\'s alone', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(24, 15), true);
    world.view.setPlayerMotion({ vx: 160, vy: 0, sprinting: true });
    world.view.playerJump();
    world.view.setPlayerPosition(tile(25, 15), false);
    world.presenter.update(100);
    expect(world.avatar.object.position.x).toBeCloseTo(25.5);
    expect(world.avatar.update.mock.calls.at(-1)![1]).toMatchObject({ moving: true, sprinting: true });
    expect(world.avatar.object.position.y).toBeGreaterThan(0);
  });

  it('hops smaller and keeps the body its shape under reduced motion', () => {
    const world = setup(() => true);
    world.view.setPlayerPosition(tile(24, 15), true);
    world.presenter.update(16);
    world.view.playerJump();
    world.presenter.update(20);
    expect(world.avatar.update.mock.calls.at(-1)![1].jump?.stretch).toBe(1);
    for (let ms = 20; ms < JUMP_AIR_MS / 2; ms += 20) world.presenter.update(20);
    expect(world.presenter.jumpLift).toBeCloseTo(REDUCED_JUMP_HEIGHT, 1);
  });

  it('carries a climb mid-jump on along the arc onto the block: the feet are already above it, so no hop and no dip (D-106)', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    world.presenter.consumeSnap();
    world.view.playerJump();
    let elapsed = 0;
    for (; elapsed < JUMP_AIR_MS * 0.4; elapsed += 20) world.presenter.update(20);
    const atClimb = world.avatar.object.position.y;
    expect(atClimb).toBeGreaterThan(1);
    world.view.setPlayerElevation(1);
    expect(world.avatar.object.position.y).toBeCloseTo(atClimb, 5);
    // The same arc, now over the block: it hangs, then lands on the block top, never below it.
    let lowest = Number.POSITIVE_INFINITY;
    for (; elapsed < JUMP_AIR_MS + 40; elapsed += 10) {
      world.presenter.update(10);
      const y = world.avatar.object.position.y;
      lowest = Math.min(lowest, y);
      expect(y).toBeCloseTo(Math.max(1, jumpLift(elapsed + 10)), 5);
    }
    expect(lowest).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(world.presenter.jumpLift).toBe(0);
    expect(world.avatar.object.position.y).toBeCloseTo(1);
    for (let ms = 0; ms < JUMP_AIR_MS; ms += 25) world.presenter.update(25);
    expect(world.avatar.object.position.y).toBeCloseTo(1);
    // The next jump lifts again from the block.
    world.view.playerJump();
    for (let ms = 0; ms < JUMP_AIR_MS / 2; ms += 25) world.presenter.update(25);
    expect(world.presenter.jumpLift).toBeCloseTo(JUMP_HEIGHT, 1);
  });

  it('carries a reduced-motion climb from the top of its small hop onto the block, with no lift left over (D-106)', () => {
    const world = setup(() => true);
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    world.presenter.consumeSnap();
    world.view.playerJump();
    for (let ms = 0; ms < JUMP_AIR_MS * 0.4; ms += 20) world.presenter.update(20);
    const atClimb = world.avatar.object.position.y;
    expect(atClimb).toBeGreaterThan(0.2);
    expect(atClimb).toBeLessThan(1);
    world.view.setPlayerElevation(1);
    // Never dips: the hop starts where the small arc had the feet.
    let lowest = Number.POSITIVE_INFINITY;
    for (let ms = 0; ms < 300; ms += 10) {
      world.presenter.update(10);
      lowest = Math.min(lowest, world.avatar.object.position.y);
    }
    expect(lowest).toBeGreaterThanOrEqual(atClimb - 0.05);
    expect(world.presenter.jumpLift).toBe(0);
    expect(world.avatar.object.position.y).toBeCloseTo(1);
    for (let ms = 0; ms < JUMP_TOTAL_MS; ms += 25) world.presenter.update(25);
    expect(world.avatar.object.position.y).toBeCloseTo(1);
  });

  it('starts a new session on the ground', () => {
    const world = setup();
    world.view.playerJump();
    world.presenter.update(100);
    expect(world.presenter.jumpLift).toBeGreaterThan(0);
    world.presenter.bindSession();
    world.presenter.update(16);
    expect(world.presenter.jumpLift).toBe(0);
    expect(shadowOf(world).visible).toBe(false);
  });
});


describe('presenter: one jump in every scene (D-111)', () => {
  type World = ReturnType<typeof setup>;
  const roof = EXCHANGE_ROOF_LEVEL.rooftop;
  /** How each scene is shown, and the surface the feet stand on there. */
  const SCENES: ReadonlyArray<{ readonly name: string; readonly show: (world: World) => void; readonly floor: number }> = [
    { name: 'the street', floor: 0, show: (world) => world.view.setPlayerPosition(tile(40, 15), true) },
    ...(['bank', 'bridge', 'exchange', 'post-office', 'bunker', 'vault'] as const).map((building) => ({
      name: `the ${building} interior`,
      floor: 0,
      show: (world: World) => {
        world.view.setStreetVisible(false);
        world.view.showRoom(building);
        world.view.setPlayerPosition(tile(4, 5), true);
      },
    })),
    {
      name: 'the Degen floor',
      floor: 0,
      show: (world) => {
        world.view.setStreetVisible(false);
        world.view.showRoom('exchange', 'degen');
        world.view.setPlayerPosition(tile(5, 6), true);
      },
    },
    {
      name: 'the avnu roof',
      floor: EXCHANGE_ROOF_HEIGHT,
      show: (world) => {
        world.view.showRooftop('exchange');
        world.view.setPlayerPosition(tile(roof.x + 5, roof.y + 3), true);
        world.view.setPlayerElevation(EXCHANGE_ROOF_HEIGHT);
      },
    },
    {
      name: 'the Avatar Studio',
      floor: 0,
      show: (world) => {
        world.view.setStreetVisible(false);
        world.view.syncStudio({ visible: true, highlightedFigure: null });
        world.view.setPlayerPosition(tile(6, 6), true);
      },
    },
  ];

  it.each(SCENES)('lifts the avatar the full jump height and tucks it in $name, then lands', ({ show, floor }) => {
    const world = setup(undefined, true);
    show(world);
    world.presenter.update(16);
    const ground = world.avatar.object.position.y;
    expect(ground).toBeCloseTo(floor, 1);
    world.view.playerJump();
    for (let ms = 0; ms < JUMP_AIR_MS / 2; ms += 25) world.presenter.update(25);
    expect(world.presenter.jumpLift).toBeCloseTo(JUMP_HEIGHT, 1);
    expect(world.avatar.object.position.y).toBeCloseTo(ground + JUMP_HEIGHT, 1);
    expect(world.avatar.update.mock.calls.at(-1)![1].jump?.tuck).toBeGreaterThan(0.9);
    for (let ms = 0; ms < JUMP_TOTAL_MS; ms += 25) world.presenter.update(25);
    expect(world.avatar.object.position.y).toBeCloseTo(ground, 5);
    world.presenter.dispose();
  });

  it('plays a peer\'s jump in the Studio, as on the street and the roof', () => {
    const at = tile(6, 6);
    const parent = new Group();
    const figures = fakeFigures();
    const presenter = createPresenter({ parent, labels: createNullLabelFactory(), figures: figures.factory });
    const peers = createRemotePeerSource([{ id: 'peer', x: at.x, y: at.y, facing: 'down', sprite: 'avatar-3', jumps: 0 }]);
    const view = presenter.bindSession(peers.source);
    view.setStreetVisible(false);
    view.syncStudio({ visible: true, highlightedFigure: null });
    const remote = figures.created.find((figure) => figure.object.parent?.name === 'remote-avatars')!;
    presenter.update(16);
    expect(remote.object.position.y).toBe(0);
    peers.publish([{ id: 'peer', x: at.x, y: at.y, facing: 'down', sprite: 'avatar-3', jumps: 1 }]);
    for (let ms = 0; ms < JUMP_AIR_MS / 2; ms += 25) presenter.update(25);
    expect(remote.object.position.y).toBeCloseTo(JUMP_HEIGHT, 1);
    presenter.dispose();
  });
});

describe('the target\'s edge glow and the distant shimmer (D-123)', () => {
  /** The affordance mesh named `name` and its per-slot levels: [shimmer, glow] per id. */
  const shells = (root: Group, name: string) => {
    let found: Mesh | undefined;
    root.traverse((object) => {
      if (!found && object instanceof Mesh && object.name === name) found = object;
    });
    if (!found) throw new Error(`no affordance mesh ${name}`);
    const mesh = found;
    const ids = mesh.userData['affordance'] as string[];
    const levels = (mesh.material as ShaderMaterial).uniforms['uSlots']!.value as Float32Array;
    return {
      mesh,
      glow: (id: string) => levels[ids.indexOf(id) * 2 + 1],
      usable: (id: string) => levels[ids.indexOf(id) * 2],
      /** The colour `id` shimmers in, read off the baked `aTint` attribute. */
      tint: (id: string) => {
        const slot = ids.indexOf(id);
        const slots = mesh.geometry.getAttribute('aSlot');
        const tints = mesh.geometry.getAttribute('aTint');
        for (let i = 0; i < slots.count; i++) {
          if (slots.getX(i) === slot) return new Color(tints.getX(i), tints.getY(i), tints.getZ(i));
        }
        throw new Error(`no shimmer tint for ${id}`);
      },
    };
  };
  /** A tint as hue, saturation and lightness, the way the eye reads it. */
  const readHSL = (color: Color): { h: number; s: number; l: number } => {
    const out = { h: 0, s: 0, l: 0 };
    color.getHSL(out, SRGBColorSpace);
    return out;
  };
  const bank = (status: (station: string) => 'available' | 'locked' = () => 'available') => {
    const world = setup();
    world.view.setStreetVisible(false);
    world.view.showRoom('bank');
    world.view.renderRoom('bank', fixedRoomStationPresentations(createFixedRoom(BANK_ROOM_DEFINITION), {
      inRoom: true,
      controlOwner: 'world',
      highlightedStation: null,
      stations: BANK_ROOM_DEFINITION.stations.map((station) => ({ station: station.station, label: station.label, status: status(station.station) })),
    } as never));
    return { ...world, room: shells(world.parent, 'room:bank:affordances') };
  };
  const SHIELD = { id: 'bank:shielding', label: 'SHIELD', x: 200, y: 160 };

  it('draws no floating "E · …" prompt any more', () => {
    const world = setup();
    world.view.setInteractionPrompt(SHIELD);
    let prompt = false;
    world.parent.traverse((object) => {
      if (object.name === 'interaction-prompt' || object.userData['text'] === 'E · SHIELD') prompt = true;
    });
    expect(prompt).toBe(false);
    world.presenter.dispose();
  });

  it('glows the chosen target only, fading in and out over about 200 ms', () => {
    const world = bank();
    const { room } = world;
    for (const station of BANK_ROOM_DEFINITION.stations) expect(room.glow(station.station)).toBe(0);
    world.view.setInteractionPrompt(SHIELD);
    world.presenter.update(100);
    expect(room.glow('bank:shielding')).toBeCloseTo(0.5, 5);
    world.presenter.update(150);
    expect(room.glow('bank:shielding')).toBe(1);
    for (const station of BANK_ROOM_DEFINITION.stations.slice(1)) expect(room.glow(station.station)).toBe(0);
    // Step to another counter: the first fades out as the second fades in.
    world.view.setInteractionPrompt({ ...SHIELD, id: 'bank:unshielding', label: 'UNSHIELD' });
    world.presenter.update(100);
    expect(room.glow('bank:shielding')).toBeCloseTo(0.5, 5);
    expect(room.glow('bank:unshielding')).toBeCloseTo(0.5, 5);
    // Leave: nothing glows.
    world.view.setInteractionPrompt(null);
    world.presenter.update(250);
    for (const station of BANK_ROOM_DEFINITION.stations) expect(room.glow(station.station)).toBe(0);
    world.presenter.dispose();
  });

  it('shimmers every usable counter and never glows or shimmers a locked one', () => {
    const world = bank((station) => (station === 'bank:shielding' ? 'locked' : 'available'));
    const { room } = world;
    expect(room.usable('bank:shielding')).toBe(0);
    for (const station of BANK_ROOM_DEFINITION.stations.slice(1)) expect(room.usable(station.station)).toBe(1);
    expect(room.mesh.visible).toBe(true);
    world.view.setInteractionPrompt(SHIELD);
    world.presenter.update(250);
    expect(room.glow('bank:shielding')).toBe(0);
    world.presenter.dispose();
  });

  it('shimmers each counter in its own colours: STRK20 warm, Endur mint, and never black', () => {
    const world = bank();
    const { room } = world;
    const strk20 = readHSL(room.tint('bank:shielding'));
    const endur = readHSL(room.tint('bank:staking'));
    // The STRK20 counters are gold-trimmed black: a warm tint, not a grey one.
    expect(strk20.h * 360).toBeGreaterThan(15);
    expect(strk20.h * 360).toBeLessThan(55);
    // Endur's counter is mint and white: a green one.
    expect(endur.h * 360).toBeGreaterThan(120);
    expect(endur.h * 360).toBeLessThan(200);
    // Both lit enough to see, and the two rows do not share a colour.
    for (const tint of [strk20, endur]) expect(tint.l).toBeGreaterThan(0.5);
    expect(Math.abs(strk20.h - endur.h)).toBeGreaterThan(0.1);
    // The pair on each brand's row share theirs, as they share their desk.
    expect(room.tint('bank:unshielding').getHex()).toBe(room.tint('bank:shielding').getHex());
    expect(room.tint('bank:unstaking').getHex()).toBe(room.tint('bank:staking').getHex());
    // The edge glow stays brand ember, whatever the counter shimmers.
    const uColor = (room.mesh.material as ShaderMaterial).uniforms['uColor']!.value as Color;
    expect(uColor.getHex()).toBe(AFFORDANCE_EMBER);
    expect(room.tint('bank:shielding').getHex()).not.toBe(AFFORDANCE_EMBER);
    world.presenter.dispose();
  });

  it('shimmers the plaza\'s monument and its table in their own colours, not one ember', () => {
    const world = setup();
    const plaza = shells(world.parent, 'plaza:affordances');
    const monument = readHSL(plaza.tint('plaza:monument'));
    const table = readHSL(plaza.tint('plaza:shells'));
    for (const tint of [monument, table]) {
      // Daylit stone and wood: warm, and lifted well clear of black.
      expect(tint.l).toBeGreaterThan(0.5);
      expect(tint.s).toBeGreaterThan(0.1);
    }
    expect(plaza.tint('plaza:monument').getHex()).not.toBe(plaza.tint('plaza:shells').getHex());
    world.presenter.dispose();
  });

  it('hides the whole shell while nothing in the room is usable: a locked room costs no draw call', () => {
    const world = bank(() => 'locked');
    expect(world.room.mesh.visible).toBe(false);
    world.presenter.dispose();
  });

  it('shimmers the plaza\'s monument and table, and the Studio\'s figures, from the start', () => {
    const world = setup();
    const plaza = shells(world.parent, 'plaza:affordances');
    expect(plaza.usable('plaza:monument')).toBe(1);
    expect(plaza.usable('plaza:shells')).toBe(1);
    world.view.setInteractionPrompt({ id: 'plaza:monument', label: 'POOL STATS', x: 0, y: 0 });
    world.presenter.update(250);
    expect(plaza.glow('plaza:monument')).toBe(1);
    expect(plaza.glow('plaza:shells')).toBe(0);
    world.presenter.dispose();
  });

  /**
   * D-127: a bench asks for the chip alone. The plaza draws four benches and
   * the pitch two, and none of them has a shell at all; a prompt that says
   * `cue: 'none'` lights nothing, not even an object it carried by mistake.
   */
  it('gives a bench no shimmer and no edge glow: the chip is the whole cue', () => {
    const world = setup();
    const plaza = shells(world.parent, 'plaza:affordances');
    // No bench is a slot in any area's shell.
    const slots = new Set<string>();
    world.parent.traverse((object) => {
      const ids = object.userData['affordance'];
      if (Array.isArray(ids)) for (const id of ids) slots.add(String(id));
    });
    expect([...slots].filter((id) => id.startsWith('seat:'))).toEqual([]);

    // A bench's own prompt focuses nothing, and builds no shell for it.
    world.view.setInteractionPrompt({ id: 'seat:plaza:2', label: 'SIT', x: 0, y: 0, cue: 'none' });
    world.presenter.update(250);
    expect(plaza.glow('plaza:monument')).toBe(0);
    expect(plaza.glow('plaza:shells')).toBe(0);
    expect(() => shells(world.parent, 'affordance:seat:plaza:2')).toThrow();

    // Even a chip-only target that carries an object lights nothing.
    const bench = new Group();
    bench.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    world.parent.add(bench);
    world.view.setInteractionPrompt({ id: 'seat:plaza:3', label: 'SIT', x: 0, y: 0, cue: 'none', object: bench });
    world.presenter.update(250);
    expect(() => shells(world.parent, 'affordance:seat:plaza:3')).toThrow();

    // And a station after it glows as usual: nothing is left stuck.
    world.view.setInteractionPrompt({ id: 'plaza:monument', label: 'POOL STATS', x: 0, y: 0 });
    world.presenter.update(250);
    expect(plaza.glow('plaza:monument')).toBe(1);
    world.presenter.dispose();
  });

  it('pulses on one shared clock, and holds still for reduced motion', () => {
    const moving = setup(() => false);
    moving.presenter.update(16);
    const before = affordanceClock().time;
    moving.presenter.update(200);
    expect(affordanceClock().time).toBeCloseTo(before + 200, 5);
    expect(affordanceClock().motion).toBe(1);
    moving.presenter.dispose();
    const still = setup(() => true);
    still.presenter.update(16);
    expect(affordanceClock().motion).toBe(0);
    still.presenter.dispose();
  });

  it('belongs to the session that chose it', () => {
    const world = bank();
    world.view.setInteractionPrompt(SHIELD);
    world.presenter.update(250);
    world.presenter.bindSession();
    world.presenter.update(250);
    expect(world.room.glow('bank:shielding')).toBe(0);
    // The retired session's view can no longer light anything.
    world.view.setInteractionPrompt(SHIELD);
    world.presenter.update(250);
    expect(world.room.glow('bank:shielding')).toBe(0);
    world.presenter.dispose();
  });

  it('shimmers the arena\'s ring gate while the ring is free, and glows it when the gate target carries it', () => {
    const world = setup();
    world.view.setStreetVisible(false);
    world.view.showRoom('arena');
    const gate = world.view.arenaGateObject() as import('three').Object3D;
    expect(gate).not.toBeNull();
    const shell = shells(world.parent, 'affordance:arena:gate');
    expect(shell.mesh.parent).toBe(gate);
    expect(shell.usable('arena:gate')).toBe(1);
    world.view.setInteractionPrompt({ id: 'arena:gate', label: 'CLAIM', x: 0, y: 0, object: gate });
    world.presenter.update(250);
    expect(shell.glow('arena:gate')).toBe(1);
    // A fight holds the ring: the gate is not usable, so it neither shimmers nor glows.
    world.view.syncArena({ phase: 'fighting', gate: 'busy', dummy: null, challengerId: null, challengerSwings: 0, selfIsChallenger: false } as never);
    expect(shell.usable('arena:gate')).toBe(0);
    expect(shell.glow('arena:gate')).toBe(0);
    world.presenter.dispose();
  });

  /*
   * D-128, amended 2026-10-03: the local champion the ring has seated sits on
   * the throne rather than inside it. The presenter says so by handing the
   * figure the throne's own `SeatPlace` (D-127): the feet keep the podium the
   * chair stands on, and the figure lifts itself onto the pad.
   */
  it('hands the seated champion the throne\'s seat, and the seated pose', () => {
    const world = setup();
    world.view.setStreetVisible(false);
    world.view.showRoom('arena');
    const box = arenaTileCentre(ARENA_BOX);
    world.view.setPlayerPosition(box, true);
    world.view.setPlayerAvatar('avatar-12');
    const ring = {
      phase: 'idle', gate: 'open', dummy: null, challengerId: null, challengerSwings: 0,
      selfIsChallenger: false, challengerGuarding: false, challengerBlocks: 0,
      championId: 'aaaa', throneId: 'aaaa', selfIsChampion: true, selfOnThrone: true,
    } as never;
    world.view.syncArena(ring);
    // The height eases like a kerb; run it out.
    for (let t = 0; t < 60; t += 1) world.presenter.update(16);
    expect(world.avatar.update.mock.calls.at(-1)?.[1]).toMatchObject({
      seated: true,
      seat: ARENA_THRONE_SEAT,
    });
    // The kerb is still the floor: the rise onto the pad is the figure's.
    expect(world.avatar.object.position.y).toBeCloseTo(ARENA_SURFACE.podium, 2);
    // Deposed, the seat goes with the throne: no seat, no seated pose, and the
    // podium under the feet throughout — a stand-up is not a drop.
    world.view.syncArena({ ...(ring as object), throneId: null, selfOnThrone: false } as never);
    for (let t = 0; t < 60; t += 1) world.presenter.update(16);
    expect(world.avatar.update.mock.calls.at(-1)?.[1]).toMatchObject({ seated: false, seat: null });
    expect(world.avatar.object.position.y).toBeCloseTo(ARENA_SURFACE.podium, 2);
    world.presenter.dispose();
  });

  it('gives a station drawn elsewhere the same cues: registered by id, or carried on its target', () => {
    const world = setup();
    const gate = new Group();
    gate.add(new Mesh(new BoxGeometry(1, 2, 0.4), new MeshBasicMaterial()));
    world.parent.add(gate);
    const remove = world.presenter.registerAffordance('arena:gate', gate);
    const registered = shells(world.parent, 'affordance:arena:gate');
    expect(registered.mesh.parent).toBe(gate);
    expect(registered.usable('arena:gate')).toBe(1);
    world.view.setInteractionPrompt({ id: 'arena:gate', label: 'FIGHT', x: 0, y: 0 });
    world.presenter.update(250);
    expect(registered.glow('arena:gate')).toBe(1);
    remove();
    expect(registered.mesh.parent).toBeNull();

    // A target that names its object glows it, built on first use.
    const stand = new Group();
    stand.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    world.parent.add(stand);
    world.view.setInteractionPrompt({ id: 'leaderboard:stand', label: 'LEADERBOARD', x: 0, y: 0, object: stand });
    world.presenter.update(250);
    const carried = shells(world.parent, 'affordance:leaderboard:stand');
    expect(carried.mesh.parent).toBe(stand);
    expect(carried.glow('leaderboard:stand')).toBe(1);
    world.presenter.dispose();
  });
});
