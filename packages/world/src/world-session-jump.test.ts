import { describe, expect, it } from 'vitest';
import { PITCH_AREA, SANDBOX_AREA, type BuildingId, type ShellEvents, type WorldEvents } from '@strkworld/shared';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';
import {
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_ROOF_LEVEL,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  isFixedRoomSolidAt,
  type FixedRoomLevelId,
  type FixedRoomLevelMap,
} from './fixed-room.js';
import { JUMP_AIR_MS, JUMP_COOLDOWN_MS } from './jump.js';
import { TILE_SIZE, createStreetMap, isSolidAt, tileToWorld } from './map/street.js';
import type { SandboxChannel } from './sandbox-channel.js';
import type { MovementInput } from './street-movement.js';
import { ROOM_ORIGIN } from './world-layout.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * The jump inside the gameplay session (D-097): Space takes off once, holds
 * until landing, cools down, never moves the player, and yields whenever the
 * World does not own the keyboard.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const STREET = createStreetMap();
const STUDIO_ENTRANCE = STREET.avatarStudioEntrance;
const BANK_DOOR = STREET.doors.find((door) => door.building === 'bank')!;

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    space(repeat?: boolean): void;
    count(event: string): number;
  } = {
    enabled: true,
    get held() {
      return this.enabled ? pressed : NO_KEYS;
    },
    sprinting: false,
    disableGlobalCapture() {},
    enableGlobalCapture() {},
    resetKeys() {
      pressed = NO_KEYS;
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return undefined;
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
      return undefined;
    },
    hold(keys) {
      pressed = { ...NO_KEYS, ...keys };
    },
    space(repeat = false) {
      for (const handler of [...(handlers.get('keydown-Space') ?? [])]) handler({ repeat, target: null });
    },
    count(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
  return keyboard;
}

/** A sandbox authority that never changes: enough for the session to build its heightmap. */
const STILL_SANDBOX: SandboxChannel = {
  subscribe(listener) {
    listener({ columns: [], carrying: null });
    return () => {};
  },
  pick() {},
  place() {},
};

function setup(options: { readonly vaultOpen?: boolean; readonly sandbox?: SandboxChannel } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
    },
  });
  const keyboard = fakeKeyboard();
  const emitted: Array<keyof WorldEvents> = [];
  const shellHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const session = createWorldSession({
    view,
    keyboard,
    ...(options.vaultOpen ? { vaultOpen: true } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    config: {
      out: { emit: (event) => emitted.push(event) },
      in: {
        on: (event, handler) => {
          if (!shellHandlers.has(event)) shellHandlers.set(event, new Set());
          shellHandlers.get(event)!.add(handler as (payload: unknown) => void);
          return () => shellHandlers.get(event)?.delete(handler as (payload: unknown) => void);
        },
      },
    },
  });
  const internals = session as unknown as {
    position: { x: number; y: number };
    inputGate: { suspend(): void; resume(): void };
  };
  return {
    session,
    keyboard,
    emitted,
    internals,
    jumps: () => calls.filter((call) => call.method === 'playerJump').length,
    jumpEvents: () => emitted.filter((event) => event === 'player:jumped').length,
    shellEmit<K extends keyof ShellEvents>(event: K, payload: ShellEvents[K]) {
      for (const handler of [...(shellHandlers.get(event) ?? [])]) handler(payload);
    },
    standOn(tile: { x: number; y: number }) {
      internals.position = tileToWorld(tile.x, tile.y);
      session.update(16);
    },
    /** Stand at a World-pixel position and let one frame report its tile. */
    placeAt(position: { x: number; y: number }) {
      internals.position = { x: position.x, y: position.y };
      session.update(16);
    },
  };
}

type World = ReturnType<typeof setup>;

const TOWER: Readonly<Record<FixedRoomLevelId, FixedRoomLevelMap>> = {
  ground: createFixedRoom(fixedRoomDefinitionsFor({}).find((room) => room.building === 'exchange')!),
  degen: createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL),
  roof: createFixedRoomLevel(EXCHANGE_ROOF_LEVEL),
};
const ROOF = EXCHANGE_ROOF_LEVEL.rooftop;

/** A floor tile's centre in World pixels: interiors at the room origin, the roof over the tower. */
function floorTileCentre(level: FixedRoomLevelId, tile: { x: number; y: number }) {
  if (level === 'roof') {
    return { x: (ROOF.x + tile.x) * TILE_SIZE + TILE_SIZE / 2, y: (ROOF.y + tile.y) * TILE_SIZE + TILE_SIZE / 2 };
  }
  return {
    x: ROOM_ORIGIN.x + tile.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    y: ROOM_ORIGIN.y + tile.y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
  };
}

/** In through `building`'s street door. */
function enter(world: World, building: BuildingId): void {
  const door = STREET_WITH_VAULT.doors.find((candidate) => candidate.building === building)!;
  world.standOn(door);
  expect(world.session.area).toBe(building);
}

/** Up the Exchange tower by lift, floor by floor. */
function climbTower(world: World, to: 'degen' | 'roof'): void {
  enter(world, 'exchange');
  const order: FixedRoomLevelId[] = ['ground', 'degen', 'roof'];
  while (world.session.level !== to) {
    const from = world.session.level!;
    const next = order[order.indexOf(from) + 1]!;
    const lift = TOWER[from].lifts.find((candidate) => candidate.to === next)!;
    world.placeAt(floorTileCentre(from, lift));
    expect(world.session.level).toBe(next);
  }
}

/** The first walkable street tile of a kind inside a rectangle. */
function streetTile(kind: string, area: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: STREET.width, height: STREET.height }) {
  for (let y = area.y + 1; y < area.y + area.height - 1; y++) {
    for (let x = area.x + 1; x < area.x + area.width - 1; x++) {
      if (STREET.tiles[y]?.[x] !== kind) continue;
      // Clear on every side, so the body stands there whole.
      if ([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => !isSolidAt(STREET, x + dx!, y + dy!))) return { x, y };
    }
  }
  throw new Error(`no ${kind} tile`);
}

const STREET_WITH_VAULT = createStreetMap({ vaultOpen: true });
const GROUND_FLOORS = fixedRoomDefinitionsFor({ vaultOpen: true }).map((definition) => definition.building);

/**
 * Every kind of place the avatar walks (D-111): where it is, how to get there,
 * and whether peers see the jump (a shared presence area) or it plays solo.
 */
const SCENES: ReadonlyArray<{
  readonly name: string;
  /** A shared presence area (peers see the jump) or a solo instance (D-087). */
  readonly shared: boolean;
  readonly options?: { readonly vaultOpen?: boolean; readonly sandbox?: SandboxChannel };
  readonly arrive: (world: World) => void;
  readonly area: string;
  readonly level?: FixedRoomLevelId | null;
}> = [
  { name: 'the street', shared: true, area: 'street', level: null, arrive: (world) => world.standOn(STREET.spawn) },
  { name: 'the Privacy Plaza', shared: true, area: 'street', level: null, arrive: (world) => world.standOn(streetTile('plaza')) },
  { name: 'the football pitch', shared: true, area: 'street', level: null, arrive: (world) => world.standOn(streetTile('turf', PITCH_AREA)) },
  {
    name: 'the block sandbox',
    shared: true,
    area: 'street',
    level: null,
    options: { sandbox: STILL_SANDBOX },
    arrive: (world) => world.standOn({ x: SANDBOX_AREA.x + 4, y: 14 }),
  },
  ...GROUND_FLOORS.map((building) => ({
    name: `the ${building} interior`,
    shared: false,
    area: building,
    level: 'ground' as const,
    options: { vaultOpen: true },
    arrive: (world: World) => enter(world, building),
  })),
  { name: 'the Degen floor', shared: false, area: 'exchange', level: 'degen', arrive: (world) => climbTower(world, 'degen') },
  { name: 'the avnu roof', shared: true, area: 'exchange', level: 'roof', arrive: (world) => climbTower(world, 'roof') },
  { name: 'the Avatar Studio (changing room)', shared: true, area: 'studio', level: null, arrive: (world) => world.standOn(STUDIO_ENTRANCE) },
];

describe('the jump in the session (D-097)', () => {
  it('takes off on Space, plays once on the view and tells the Shell, standing still', () => {
    const world = setup();
    expect(world.session.jump).toBe('ready');
    world.keyboard.space();
    expect(world.session.jump).toBe('airborne');
    expect(world.jumps()).toBe(1);
    expect(world.jumpEvents()).toBe(1);
  });

  it('has no double jump, holds until landing, then cools down before the next', () => {
    const world = setup();
    // Frames are clamped to 100 ms, so time passes in 50 ms frames.
    const advance = (ms: number) => {
      for (let done = 0; done < ms; done += 50) world.session.update(50);
    };
    world.keyboard.space();
    advance(JUMP_AIR_MS / 2);
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
    advance(JUMP_AIR_MS / 2);
    expect(world.session.jump).toBe('cooldown');
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
    advance(JUMP_COOLDOWN_MS);
    expect(world.session.jump).toBe('ready');
    world.keyboard.space();
    expect(world.jumps()).toBe(2);
    expect(world.jumpEvents()).toBe(2);
  });

  it('ignores a held key\'s repeats', () => {
    const world = setup();
    world.keyboard.space(true);
    expect(world.jumps()).toBe(0);
    expect(world.session.jump).toBe('ready');
  });

  it('never changes movement: a walk during a jump covers the same ground as one without', () => {
    const walk = (jump: boolean) => {
      const world = setup();
      const start = world.session.player;
      world.keyboard.hold({ right: true });
      if (jump) world.keyboard.space();
      for (let frame = 0; frame < 30; frame += 1) world.session.update(16);
      return { dx: world.session.player.x - start.x, dy: world.session.player.y - start.y };
    };
    const plain = walk(false);
    expect(plain.dx).toBeGreaterThan(0);
    expect(walk(true)).toEqual(plain);
  });

  it('yields while a panel or Shell claim holds the keyboard', () => {
    const world = setup();
    world.internals.inputGate.suspend();
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
    world.internals.inputGate.resume();
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
  });

  it('yields while a room\'s counter holds the controls (control-owner shell), and jumps indoors otherwise', () => {
    const world = setup();
    world.standOn(BANK_DOOR);
    expect(world.session.area).toBe('bank');
    world.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
    world.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    world.keyboard.space();
    // Indoors the jump plays for the player alone; the Shell sends nothing
    // from a private interior, because presence is suspended there.
    expect(world.jumps()).toBe(1);
  });

  it('jumps in the Avatar Studio too (D-111), and yields there to a Shell claim', () => {
    const world = setup();
    world.standOn(STUDIO_ENTRANCE);
    expect(world.session.area).toBe('studio');
    world.internals.inputGate.suspend();
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
    world.internals.inputGate.resume();
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
    expect(world.jumpEvents()).toBe(1);
  });

  it('leaves E and F to their own actions: Space is only ever the jump', () => {
    const world = setup();
    expect(world.keyboard.count('keydown-Space')).toBe(1);
    world.keyboard.space();
    expect(world.emitted).toEqual(expect.not.arrayContaining(['avatar:selected']));
  });

  it('releases the Space binding on destroy', () => {
    const world = setup();
    world.session.destroy();
    expect(world.keyboard.count('keydown-Space')).toBe(0);
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
  });
});

describe('the jump everywhere the avatar walks (D-111)', () => {
  it('covers every ground floor a World can build, the bunker and the opened Vault included', () => {
    expect(GROUND_FLOORS).toEqual(expect.arrayContaining(['bank', 'bridge', 'exchange', 'post-office', 'bunker', 'arena', 'vault']));
  });

  it.each(SCENES)('takes off in $name (shared: $shared), the same jump, without moving the player', (scene) => {
    const world = setup(scene.options);
    scene.arrive(world);
    expect(world.session.area).toBe(scene.area);
    if (scene.level !== undefined) expect(world.session.level).toBe(scene.level);
    const before = world.session.player;
    // The arena's arrival leap down from the pit's arch is the view's jump too (D-114).
    const leaps = world.jumps();
    world.keyboard.space();
    expect(world.session.jump).toBe('airborne');
    expect(world.jumps()).toBe(leaps + 1);
    // The World always tells the Shell; the Shell forwards it to the lobby
    // only from a shared area (the presence controller and LobbyClient.jump).
    expect(world.jumpEvents()).toBe(1);
    for (let ms = 0; ms < JUMP_AIR_MS + JUMP_COOLDOWN_MS; ms += 50) world.session.update(50);
    expect(world.session.player).toEqual(before);
    expect(world.session.area).toBe(scene.area);
    expect(world.session.jump).toBe('ready');
    world.keyboard.space();
    expect(world.jumps()).toBe(leaps + 2);
  });

  it.each(SCENES)('yields in $name while a panel or Shell claim holds the keyboard', (scene) => {
    const world = setup(scene.options);
    scene.arrive(world);
    const leaps = world.jumps();
    world.internals.inputGate.suspend();
    world.keyboard.space();
    expect(world.jumps()).toBe(leaps);
    expect(world.jumpEvents()).toBe(0);
  });

  it.each(GROUND_FLOORS)('yields in the %s while its counter holds the controls', (building) => {
    const world = setup({ vaultOpen: true });
    enter(world, building);
    const leaps = world.jumps();
    world.shellEmit('world:control-owner', { building, owner: 'shell' });
    world.keyboard.space();
    expect(world.jumps()).toBe(leaps);
    world.shellEmit('world:control-owner', { building, owner: 'world' });
    world.keyboard.space();
    expect(world.jumps()).toBe(leaps + 1);
  });

  /**
   * Indoors nothing is climbable: a counter, a booth, a shelf or a wall is a
   * solid tile, and only the sandbox has a heightmap. So a jump into
   * furniture, held for its whole air time from every tile in front of
   * something solid, never puts the body on or in it, nor out of the room.
   */
  const INTERIORS: ReadonlyArray<{ readonly name: string; readonly building: BuildingId; readonly level: 'ground' | 'degen'; readonly map: FixedRoomLevelMap }> = [
    ...fixedRoomDefinitionsFor({ vaultOpen: true }).map((definition) => ({
      name: definition.building,
      building: definition.building,
      level: 'ground' as const,
      map: createFixedRoom(definition),
    })),
    { name: 'exchange degen', building: 'exchange', level: 'degen', map: TOWER.degen },
  ];

  it.each(INTERIORS)('never lands a jump on or in the $name furniture or walls', ({ building, level, map }) => {
    const half = AVATAR_BODY_SIZE / 2 - 0.5;
    let checked = 0;
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        if (isFixedRoomSolidAt(map, x, y) || !isFixedRoomSolidAt(map, x, y - 1)) continue;
        // A lift, an exit or an open counter would take the player away: skip those tiles.
        if (map.lifts.some((lift) => x >= lift.x && x < lift.x + lift.width && y >= lift.y && y < lift.y + lift.height)) continue;
        const world = setup({ vaultOpen: true });
        if (level === 'degen') climbTower(world, 'degen');
        else enter(world, building);
        world.placeAt(floorTileCentre(level, { x, y }));
        if (world.session.area !== building || world.session.level !== level) continue;
        world.keyboard.hold({ up: true });
        world.keyboard.space();
        for (let ms = 0; ms < JUMP_AIR_MS; ms += 16) {
          world.session.update(16);
          if (world.session.area !== building || world.session.level !== level) break;
          const p = world.session.player;
          for (const [dx, dy] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) {
            const tile = {
              x: Math.floor((p.x + dx - ROOM_ORIGIN.x) / FIXED_ROOM_TILE_SIZE),
              y: Math.floor((p.y + dy - ROOM_ORIGIN.y) / FIXED_ROOM_TILE_SIZE),
            };
            expect(isFixedRoomSolidAt(map, tile.x, tile.y), `${building} ${level} from ${x},${y} -> ${tile.x},${tile.y}`).toBe(false);
          }
          checked += 1;
        }
        world.session.destroy();
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
