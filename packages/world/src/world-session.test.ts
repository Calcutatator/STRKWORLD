import { describe, expect, it, vi } from 'vitest';
import { STREET_ORIGIN_X, type AvatarSpriteKey, type BuildingId, type ShellEvents, type WorldEvents } from '@strkworld/shared';
import { pairedAvatarSprite } from './avatar-state.js';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_TILE_SIZE,
  avatarStudioSpawnToWorld,
  type AvatarStudioController,
} from './avatar-studio.js';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';
import {
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_DEGEN_STATION,
  EXCHANGE_ROOF_HEIGHT,
  EXCHANGE_ROOF_LEVEL,
  BUNKER_ELEVATOR_PROMPT,
  FIXED_ROOM_DEFINITIONS,
  FIXED_ROOM_LEVELS,
  FIXED_ROOM_TILE_SIZE,
  VAULT_SUPPLY_STATION,
  VAULT_ROOM_DEFINITION,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  fixedRoomLiftAt,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  type FixedRoomStationDefinition,
  type FixedRoomController,
  type FixedRoomLevelId,
  type FixedRoomLevelMap,
} from './fixed-room.js';
import type { InputGate } from './input-gate.js';
import {
  AVATAR_STUDIO_RETURN_FACING,
  avatarStudioReturnTile,
  createStreetMap,
  doorAt,
  isSolidAt,
  TILE_SIZE,
  tileToWorld,
  worldToTile,
} from './map/street.js';
import { PLAZA_MONUMENT_STATION } from './map/plaza.js';
import type { InteractionTarget } from './interaction.js';
import { PLAYER_WALK_SPEED } from './movement-input.js';
import type { MovementInput } from './street-movement.js';
import { ROOM_ORIGIN } from './world-layout.js';
import {
  cardinalMovementInput,
  createWorldSession,
  MAX_SESSION_FRAME_MS,
  rotateScreenVelocity,
  type WorldFrame,
  type WorldKeyboard,
  type WorldSession,
  type WorldSessionConfig,
  type WorldSessionView,
} from './world-session.js';
import { DOOR_REENTRY_HOLD_MS } from './door-trigger.js';

/**
 * The World session, driven headlessly (D-059).
 *
 * This is the StreetScene lifecycle suite carried over to the engine-agnostic
 * session. The door trigger, fixed rooms, Avatar Studio, outfit selection and
 * input gate all run for real; only the edges are fakes: a recording view
 * (every call journaled in order, any call made to throw on demand), a keyboard
 * and a World/Shell bus, all writing to one shared journal so cross-seam order
 * is assertable.
 *
 * The Scene suite reached into the same private fields this one does
 * (`player.x`, `lastTile`, `avatarStudio`, `roomControllers`, `inputGate`).
 * Every such access goes through `internals()`, so a rename is a one-line fix.
 */

const STREET = createStreetMap();
const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const IDLE_MOTION = Object.freeze({ vx: 0, vy: 0, sprinting: false });
type RoomBuilding = keyof typeof FIXED_ROOM_DEFINITIONS;
const ROOM_BUILDINGS = Object.keys(FIXED_ROOM_DEFINITIONS) as RoomBuilding[];
const BANK_STATION = FIXED_ROOM_DEFINITIONS.bank.stations[0];
/** The tile directly south of the Bank station: its approach. */
const BANK_APPROACH = { x: BANK_STATION.x, y: BANK_STATION.y + BANK_STATION.height };
const STUDIO_ENTRANCE = { x: STREET.avatarStudioEntrance.x, y: STREET.avatarStudioEntrance.y };
const STUDIO_EXIT = { x: AVATAR_STUDIO_DEFINITION.exit.x, y: AVATAR_STUDIO_DEFINITION.exit.y };
/** D-125: the street tile the Studio's exit puts the player on, just outside its entrance. */
const STUDIO_RETURN = avatarStudioReturnTile(STREET);
const STUDIO_SPAWN = avatarStudioSpawnToWorld(
  AVATAR_STUDIO_DEFINITION,
  ROOM_ORIGIN,
  AVATAR_STUDIO_TILE_SIZE,
);
// Derived from the map: the street widened to reach the block sandbox (D-060).
const STREET_MAP = createStreetMap();
const STREET_BOUNDS = {
  x: 0,
  y: 0,
  width: STREET_MAP.width * TILE_SIZE,
  height: STREET_MAP.height * TILE_SIZE,
};
const INTERIOR_BOUNDS = { x: ROOM_ORIGIN.x, y: ROOM_ORIGIN.y, width: 576, height: 384 };
/** Distance covered by one 16 ms walking frame. */
const WALK_STEP = (PLAYER_WALK_SPEED * 16) / 1000;

type Journal = string[];
type Point = { readonly x: number; readonly y: number };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type WorldEmitted = {
  [K in keyof WorldEvents]: { readonly event: K; readonly payload: WorldEvents[K] };
}[keyof WorldEvents];

type Listener = (payload: unknown) => void;

/** The World's outbound bus plus the Shell's inbound one, as the engine passes them. */
function createFakeBus(journal: Journal) {
  const emitted: WorldEmitted[] = [];
  const hooks: Array<{ readonly event: keyof WorldEvents; readonly run: Listener }> = [];
  const shellHandlers = new Map<keyof ShellEvents, Set<Listener>>();
  let subscriptions = 0;
  let subscriptionFailure: { readonly at: number; readonly error: Error } | undefined;

  const config: WorldSessionConfig = {
    out: {
      emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
        // Record first, then deliver: a consumer that throws still saw the event.
        journal.push(`out:${event}`);
        emitted.push({ event, payload } as WorldEmitted);
        const index = hooks.findIndex((hook) => hook.event === event);
        if (index === -1) return;
        const [hook] = hooks.splice(index, 1);
        hook?.run(payload);
      },
    },
    in: {
      on<K extends keyof ShellEvents>(event: K, handler: (payload: ShellEvents[K]) => void) {
        const index = subscriptions;
        subscriptions += 1;
        if (subscriptionFailure?.at === index) {
          const { error } = subscriptionFailure;
          subscriptionFailure = undefined;
          throw error;
        }
        journal.push(`shell.on:${event}`);
        const listener = handler as Listener;
        const handlers = shellHandlers.get(event) ?? new Set<Listener>();
        handlers.add(listener);
        shellHandlers.set(event, handlers);
        return () => {
          journal.push(`shell.off:${event}`);
          handlers.delete(listener);
        };
      },
    },
  };

  return {
    config,
    emitted,
    count: (event: keyof WorldEvents): number =>
      emitted.filter((entry) => entry.event === event).length,
    payloads<K extends keyof WorldEvents>(event: K): WorldEvents[K][] {
      return emitted
        .filter((entry) => entry.event === event)
        .map((entry) => entry.payload as WorldEvents[K]);
    },
    /** Run `run` once, while the next `event` is being delivered. */
    once<K extends keyof WorldEvents>(event: K, run: (payload: WorldEvents[K]) => void): void {
      hooks.push({ event, run: run as Listener });
    },
    /** The next `event` is recorded, then its delivery throws. */
    failNext(event: keyof WorldEvents, error: Error): void {
      hooks.push({
        event,
        run: () => {
          throw error;
        },
      });
    },
    shellEmit<K extends keyof ShellEvents>(event: K, payload: ShellEvents[K]): void {
      for (const handler of [...(shellHandlers.get(event) ?? [])]) handler(payload);
    },
    shellListenerCount: (): number =>
      [...shellHandlers.values()].reduce((total, handlers) => total + handlers.size, 0),
    /** Let `successes` more Shell subscriptions succeed, then fail the next one. */
    failShellSubscriptionAfter(successes: number, error: Error): void {
      subscriptionFailure = { at: subscriptions + successes, error };
    },
  };
}

interface OutfitKeyEvent {
  readonly repeat: boolean;
  readonly target: unknown;
}

type OutfitHandler = (event: OutfitKeyEvent) => void;

class FakeKeyboard implements WorldKeyboard {
  enabled = true;
  sprinting = false;
  /**
   * A keyboard that keeps reporting held keys while disabled breaks the
   * `WorldKeyboard` contract. It proves a guard does not lean on that contract.
   */
  leaksWhileDisabled = false;
  private pressed: MovementInput = NO_KEYS;
  private readonly handlers = new Set<OutfitHandler>();
  /** D-117: the interact key, tracked apart so the F journal stays as it was. */
  private readonly interactHandlers = new Set<OutfitHandler>();
  readonly disableGlobalCapture = vi.fn(() => {
    this.journal.push('keyboard.disableGlobalCapture');
  });
  readonly enableGlobalCapture = vi.fn(() => {
    this.journal.push('keyboard.enableGlobalCapture');
  });
  readonly resetKeys = vi.fn(() => {
    this.journal.push('keyboard.resetKeys');
    this.pressed = NO_KEYS;
  });

  constructor(private readonly journal: Journal) {}

  get held(): MovementInput {
    return this.enabled || this.leaksWhileDisabled ? this.pressed : NO_KEYS;
  }

  hold(keys: Partial<MovementInput>): void {
    this.pressed = { ...NO_KEYS, ...keys };
  }

  release(): void {
    this.pressed = NO_KEYS;
  }

  // The outfit key is journalled; E (D-117) is tracked apart (`pressE`).
  on(event: 'keydown-F' | 'keydown-E', handler: OutfitHandler): this {
    if (event === 'keydown-E') {
      this.interactHandlers.add(handler);
      return this;
    }
    if (event !== 'keydown-F') return this;
    this.journal.push(`keyboard.on:${event}`);
    this.handlers.add(handler);
    return this;
  }

  off(event: 'keydown-F' | 'keydown-E', handler: OutfitHandler): this {
    if (event === 'keydown-E') {
      this.interactHandlers.delete(handler);
      return this;
    }
    if (event !== 'keydown-F') return this;
    this.journal.push(`keyboard.off:${event}`);
    this.handlers.delete(handler);
    return this;
  }

  listenerCount(): number {
    return this.handlers.size;
  }

  snapshot(): OutfitHandler {
    const handler = this.handlers.values().next().value;
    if (!handler) throw new Error('Missing keydown-F handler');
    return handler;
  }

  press(event: OutfitKeyEvent = { repeat: false, target: null }): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  /** D-117: press E, as the DOM keyboard delivers it while enabled. */
  pressE(event: OutfitKeyEvent = { repeat: false, target: null }): void {
    if (!this.enabled) return;
    for (const handler of [...this.interactHandlers]) handler(event);
  }

  interactListenerCount(): number {
    return this.interactHandlers.size;
  }
}

type ViewPort = Required<WorldSessionView>;
type ViewMethod = keyof ViewPort;
type ViewArgs<M extends ViewMethod> = Parameters<ViewPort[M]>;

interface ViewCall {
  readonly method: ViewMethod;
  readonly args: readonly unknown[];
}

interface ViewRule {
  readonly method: ViewMethod;
  readonly matches: (args: readonly unknown[]) => boolean;
  readonly run: (args: readonly unknown[]) => void;
}

/** A renderer that draws nothing: it journals each call and can intercept one. */
function createRecordingView(journal: Journal) {
  const calls: ViewCall[] = [];
  const rules: ViewRule[] = [];

  const record = <M extends ViewMethod>(method: M, args: ViewArgs<M>): void => {
    calls.push({ method, args });
    journal.push(`view.${method}`);
    const index = rules.findIndex((rule) => rule.method === method && rule.matches(args));
    if (index === -1) return;
    const [rule] = rules.splice(index, 1);
    rule?.run(args);
  };

  // Copy every argument so a recording never aliases session state.
  const view: ViewPort = {
    setPlayerPosition: (position, snap) =>
      record('setPlayerPosition', [{ x: position.x, y: position.y }, snap]),
    setPlayerMotion: (motion) =>
      record('setPlayerMotion', [{ vx: motion.vx, vy: motion.vy, sprinting: motion.sprinting }]),
    setPlayerAvatar: (sprite) => record('setPlayerAvatar', [sprite]),
    setPlayerSeated: (seated) => record('setPlayerSeated', [seated]),
    setStreetVisible: (visible) => record('setStreetVisible', [visible]),
    setDoorsVisible: (visible) => record('setDoorsVisible', [visible]),
    setLabelsVisible: (visible) => record('setLabelsVisible', [visible]),
    setRemoteVisible: (visible) => record('setRemoteVisible', [visible]),
    showRoom: (building, level) => record('showRoom', level === undefined ? [building] : [building, level]),
    renderRoom: (building, stations) => record('renderRoom', [building, stations]),
    showRooftop: (building) => record('showRooftop', [building]),
    syncStudio: (state) =>
      record('syncStudio', [{ visible: state.visible, highlightedFigure: state.highlightedFigure }]),
    destroyStudio: () => record('destroyStudio', []),
    setCameraBounds: (bounds) =>
      record('setCameraBounds', [
        { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      ]),
    destroy: () => record('destroy', []),
    setPlayerElevation: (level) => record('setPlayerElevation', [level]),
    setSandboxColumns: (columns) => record('setSandboxColumns', [columns]),
    sandboxDrop: (tile) => record('sandboxDrop', [{ x: tile.x, y: tile.y }]),
    sandboxBurst: (tile) => record('sandboxBurst', [{ x: tile.x, y: tile.y }]),
    setCarried: (colour) => record('setCarried', [colour]),
    setSandboxAim: (aim) => record('setSandboxAim', [aim]),
    setInteractionPrompt: (prompt) => record('setInteractionPrompt', [prompt]),
    setPlazaStats: (stats) => record('setPlazaStats', [stats]),
    setFootball: (frame) => record('setFootball', [frame]),
    setKickPrompt: (visible) => record('setKickPrompt', [visible]),
    footballMoment: (moment) => record('footballMoment', [moment]),
    playerJump: () => record('playerJump', []),
    syncArena: (frame) => record('syncArena', [frame]),
    setArenaPrompt: (text) => record('setArenaPrompt', [text]),
    playerSwing: () => record('playerSwing', []),
    setPlayerFacing: (facing) => record('setPlayerFacing', [facing]),
    arenaGateObject: () => {
      record('arenaGateObject', []);
      return null;
    },
  };

  const argsOf = <M extends ViewMethod>(method: M): ViewArgs<M>[] =>
    calls.filter((call) => call.method === method).map((call) => call.args as ViewArgs<M>);

  /** Run `run` once, on the next call to `method` whose arguments match. */
  const once = <M extends ViewMethod>(
    method: M,
    run: (...args: ViewArgs<M>) => void,
    matches: (...args: ViewArgs<M>) => boolean = () => true,
  ): void => {
    rules.push({
      method,
      matches: (args) => matches(...(args as ViewArgs<M>)),
      run: (args) => run(...(args as ViewArgs<M>)),
    });
  };

  return {
    view,
    calls,
    argsOf,
    once,
    /** The next matching call is recorded, then throws. */
    failNext<M extends ViewMethod>(
      method: M,
      error: Error,
      matches?: (...args: ViewArgs<M>) => boolean,
    ): void {
      once(
        method,
        () => {
          throw error;
        },
        matches,
      );
    },
    count: (method: ViewMethod): number => argsOf(method).length,
    last: <M extends ViewMethod>(method: M): ViewArgs<M> | undefined => argsOf(method).at(-1),
    avatars: (): AvatarSpriteKey[] => argsOf('setPlayerAvatar').map(([sprite]) => sprite),
    positions: () =>
      argsOf('setPlayerPosition').map(([position, snap]) => ({
        position: { x: position.x, y: position.y },
        snap,
      })),
  };
}

type RecordingView = ReturnType<typeof createRecordingView>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SessionInternals {
  position: { x: number; y: number };
  lastTile: { x: number; y: number };
  activeRoom?: BuildingId;
  inputGate: InputGate;
  roomControllers: Partial<Record<BuildingId, FixedRoomController>>;
  avatarStudio?: AvatarStudioController;
}

function internals(session: WorldSession): SessionInternals {
  return session as unknown as SessionInternals;
}

interface SessionCycle {
  readonly view: RecordingView;
  session?: WorldSession;
}

/**
 * One keyboard and one bus shared by every session, the way the engine keeps
 * the Shell bus across a rebind; each session gets a fresh view. A session
 * that fails to construct still leaves its cycle (and view) behind to inspect.
 */
function createWorld(
  options: { readonly keyboard?: boolean; readonly config?: boolean; readonly vaultOpen?: boolean } = {},
) {
  const journal: Journal = [];
  const bus = createFakeBus(journal);
  const keyboard = new FakeKeyboard(journal);
  const cycles: SessionCycle[] = [];
  const tiles: Point[] = [];
  let observer: ((tile: Point) => void) | undefined;
  let prepareNextView: ((view: RecordingView) => void) | undefined;

  const cycle = (index = cycles.length - 1): SessionCycle => {
    const record = cycles[index];
    if (!record) throw new Error(`No session cycle ${index}`);
    return record;
  };
  const live = (): WorldSession => {
    const session = cycle().session;
    if (!session) throw new Error('The current session failed to construct');
    return session;
  };

  return {
    journal,
    bus,
    keyboard,
    cycles,
    tiles,
    cycle,
    get session(): WorldSession {
      return live();
    },
    get view(): RecordingView {
      return cycle().view;
    },
    start(): WorldSession {
      const view = createRecordingView(journal);
      const prepare = prepareNextView;
      prepareNextView = undefined;
      prepare?.(view);
      const record: SessionCycle = { view };
      cycles.push(record);
      const session = createWorldSession({
        config: options.config === false ? undefined : bus.config,
        view: view.view,
        keyboard: options.keyboard === false ? undefined : keyboard,
        onTileChanged: (tile) => {
          tiles.push({ x: tile.x, y: tile.y });
          observer?.(tile);
        },
        ...(options.vaultOpen === undefined ? {} : { vaultOpen: options.vaultOpen }),
      });
      record.session = session;
      return session;
    },
    /** Arrange the next session's view before its constructor runs. */
    beforeNextStart(prepare: (view: RecordingView) => void): void {
      prepareNextView = prepare;
    },
    observeTiles(next: (tile: Point) => void): void {
      observer = next;
    },
    press(): void {
      keyboard.press({ repeat: false, target: null });
    },
    room(building: RoomBuilding): FixedRoomController {
      const controller = internals(live()).roomControllers[building];
      if (!controller) throw new Error(`Missing room controller for ${building}`);
      return controller;
    },
    studio(): AvatarStudioController {
      const studio = internals(live()).avatarStudio;
      if (!studio) throw new Error('Missing Avatar Studio controller');
      return studio;
    },
    /** Sprites a cycle's view was asked to wear after its spawn avatar. */
    applied(index = cycles.length - 1): AvatarSpriteKey[] {
      return cycle(index).view.avatars().slice(1);
    },
    /**
     * What the local avatar is wearing. The Studio must read the same key: a
     * Studio holding a different one is exactly the divergence D-053 prevents.
     */
    selected(): AvatarSpriteKey {
      const worn = cycle().view.avatars().at(-1);
      if (!worn) throw new Error('No avatar applied');
      expect(internals(live()).avatarStudio?.state.selected).toBe(worn);
      return worn;
    },
    /**
     * The toggle is cosmetic. Its only outbound event is the existing
     * `avatar:selected` carrying the opaque sprite key, and no new event
     * appears alongside the ones the transitions under test already emit.
     */
    expectOnlySelectionOnTheWire(alsoExpected: readonly (keyof WorldEvents)[]): void {
      const selections = bus.payloads('avatar:selected');
      expect(selections.length).toBeGreaterThan(0);
      for (const payload of selections) expect(Object.keys(payload)).toEqual(['sprite']);
      expect(new Set(bus.emitted.map((entry) => entry.event))).toEqual(
        new Set(['avatar:selected', ...alsoExpected]),
      );
    },
  };
}

type World = ReturnType<typeof createWorld>;

/** The port of `player.x = …`: move the session's own position without a step. */
function place(session: WorldSession, position: Point): void {
  internals(session).position = { x: position.x, y: position.y };
}

function streetTileCentre(tile: Point): { x: number; y: number } {
  return tileToWorld(tile.x, tile.y);
}

function interiorTileCentre(tile: Point, tileSize = FIXED_ROOM_TILE_SIZE): { x: number; y: number } {
  return {
    x: ROOM_ORIGIN.x + tile.x * tileSize + tileSize / 2,
    y: ROOM_ORIGIN.y + tile.y * tileSize + tileSize / 2,
  };
}

function studioTileCentre(tile: Point): { x: number; y: number } {
  return interiorTileCentre(tile, AVATAR_STUDIO_TILE_SIZE);
}

function doorTile(building: BuildingId): { x: number; y: number } {
  const door = STREET.doors.find((candidate) => candidate.building === building);
  if (!door) throw new Error(`No door for ${building}`);
  return { x: door.x, y: door.y };
}

/** Where a room exit puts the player: the street tile below the door. */
function returnTile(building: BuildingId): { x: number; y: number } {
  const door = doorTile(building);
  return { x: door.x, y: door.y + 1 };
}

function tick(world: World, deltaMs = 16, frame?: WorldFrame): void {
  world.session.update(deltaMs, frame);
}

function tickHolding(
  world: World,
  keys: Partial<MovementInput>,
  deltaMs = 16,
  frame?: WorldFrame,
): void {
  world.keyboard.hold(keys);
  try {
    tick(world, deltaMs, frame);
  } finally {
    world.keyboard.release();
  }
}

/** A room exit holds the doors briefly (door-trigger.ts): let the hold run out, standing still. */
function waitOutDoorHold(world: World): void {
  for (let t = 0; t < DOOR_REENTRY_HOLD_MS; t += MAX_SESSION_FRAME_MS) tick(world, MAX_SESSION_FRAME_MS);
}

function enterBuilding(world: World, building: RoomBuilding): void {
  if (world.session.area === 'street') waitOutDoorHold(world);
  place(world.session, streetTileCentre(doorTile(building)));
  tick(world);
  expect(world.session.area).toBe(building);
}

function leaveRoomByExit(world: World, building: RoomBuilding): void {
  place(world.session, interiorTileCentre(FIXED_ROOM_DEFINITIONS[building].exit));
  tick(world);
  expect(world.session.area).toBe('street');
}

function enterStudioByEntrance(world: World): void {
  place(world.session, streetTileCentre(STUDIO_ENTRANCE));
  tick(world);
  expect(world.session.area).toBe('studio');
}

/** Studio tiles report only after a move, so arrive with a small step south. */
function stepOntoStudioTile(world: World, tile: Point): void {
  place(world.session, studioTileCentre(tile));
  tickHolding(world, { down: true });
}

function makeBankStationAvailable(world: World): void {
  world.bus.shellEmit('world:stations', {
    building: 'bank',
    stations: [{ station: BANK_STATION.station, label: 'SHIELD', status: 'available' }],
  });
}

function thrownBy(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

function expectCompleteCleanup(cycle: SessionCycle): void {
  expect(cycle.view.count('destroyStudio')).toBe(1);
  expect(cycle.view.count('destroy')).toBe(1);
}

function countEntries(journal: readonly string[], prefix: string): number {
  return journal.filter((entry) => entry.startsWith(prefix)).length;
}

// ---------------------------------------------------------------------------
// The StreetScene lifecycle suite, ported
// ---------------------------------------------------------------------------

/*
 * Scene cases that did not carry over, because what they guarded no longer
 * exists: shutdown-hook removal during a same-instance restart, the
 * registry-owned remote peer source (remote avatars belong to the presenter),
 * and the Phaser object-retention cases of the art suite. A restart is now
 * "destroy, then construct a new session", which is how the engine rebinds.
 */
describe('WorldSession lifecycle', () => {
  it('retries E at a Studio figure after selection delivery fails (D-117)', () => {
    const world = createWorld();
    world.start();
    enterStudioByEntrance(world);

    const error = new Error('selection delivery failed');
    world.bus.failNext('avatar:selected', error);
    // Figure 2 stands on Studio tile (5, 3).
    place(world.session, studioTileCentre({ x: 5, y: 3 }));
    const sentinel = { ...internals(world.session).lastTile };

    // Walking onto it selects nothing: it only shows the prompt.
    tickHolding(world, { down: true });
    expect(internals(world.session).lastTile).not.toEqual(sentinel);
    expect(world.selected()).toBe('avatar-1');
    expect(world.session.interactionPrompt).toMatchObject({ id: 'studio:figure-2', label: 'WEAR' });

    expect(() => world.keyboard.pressE()).toThrow(error);
    expect(world.selected()).toBe('avatar-1');

    expect(() => world.keyboard.pressE()).not.toThrow();
    expect(world.selected()).toBe('avatar-2');
  });

  it('rolls back the rendered avatar when selection delivery fails after applying it', () => {
    const world = createWorld();
    world.start();
    const error = new Error('selection delivery failed');
    world.bus.failNext('avatar:selected', error);

    expect(() => world.press()).toThrow(error);
    expect(world.studio().state.selected).toBe('avatar-1');
    expect(world.applied()).toEqual(['avatar-9', 'avatar-1']);
  });

  it('toggles the outfit outdoors, in the Studio and back, from one session-owned binding', () => {
    const world = createWorld();
    world.start();

    // D-053: the binding exists from construction, not only while a room is active.
    expect(world.keyboard.listenerCount()).toBe(1);
    expect(world.selected()).toBe('avatar-1');

    world.press();
    expect(world.selected()).toBe('avatar-9');
    world.press();
    expect(world.selected()).toBe('avatar-1');
    world.press();
    expect(world.selected()).toBe('avatar-9');

    // The Studio reads the same selection rather than owning a second one, so
    // an outdoor toggle is still the current state on entry.
    enterStudioByEntrance(world);
    expect(world.keyboard.listenerCount()).toBe(1);
    expect(world.selected()).toBe('avatar-9');
    world.press();
    expect(world.selected()).toBe('avatar-1');

    // E at a figure selects it (D-117), and F pairs that figure.
    stepOntoStudioTile(world, { x: 14, y: 6 });
    expect(world.selected()).toBe('avatar-1');
    world.keyboard.pressE();
    expect(world.selected()).toBe('avatar-8');
    world.press();
    expect(world.selected()).toBe('avatar-16');

    // Leaving the Studio does not take the binding with it.
    stepOntoStudioTile(world, STUDIO_EXIT);
    expect(world.studio().state.inRoom).toBe(false);
    expect(world.session.area).toBe('street');
    expect(world.keyboard.listenerCount()).toBe(1);
    world.press();
    expect(world.selected()).toBe('avatar-8');

    world.expectOnlySelectionOnTheWire([
      'avatar-studio:entered',
      'avatar-studio:exited',
      'player:moved',
      // D-087: the Studio is shared, so it publishes where the player stands.
      'area:moved',
    ]);
  });

  it('keeps toggling inside every fixed-room interior', () => {
    const world = createWorld();
    world.start();
    expect(ROOM_BUILDINGS.length).toBeGreaterThan(0);

    for (const building of ROOM_BUILDINGS) {
      enterBuilding(world, building);
      expect(world.room(building).state.inRoom).toBe(true);

      const inside = world.selected();
      world.press();
      expect(world.selected()).toBe(pairedAvatarSprite(inside));
      world.press();
      expect(world.selected()).toBe(inside);
      // One session-owned binding; no building added its own.
      expect(world.keyboard.listenerCount()).toBe(1);

      leaveRoomByExit(world, building);
      expect(world.room(building).state.inRoom).toBe(false);
      world.press();
      expect(world.selected()).toBe(pairedAvatarSprite(inside));
      world.press();
      expect(world.selected()).toBe(inside);
    }

    // Rooms are entered through their doors here, so the door trigger's entry
    // is on the wire too, and the bunker's shared moves (D-112); nothing else is.
    world.expectOnlySelectionOnTheWire(['building:entered', 'building:exited', 'player:moved', 'area:moved']);
  });

  it('is inactive while World gameplay input is suspended', () => {
    const world = createWorld();
    world.start();

    // Menu mode: the Shell claims control and the gate hands over the keyboard.
    enterBuilding(world, 'bank');
    const held = world.selected();
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(world.session.inputSuspended).toBe(true);
    world.press();
    expect(world.selected()).toBe(held);
    // The listener is still the session's; it simply refuses to act.
    expect(world.keyboard.listenerCount()).toBe(1);

    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    expect(world.session.inputSuspended).toBe(false);
    world.press();
    expect(world.selected()).toBe(pairedAvatarSprite(held));

    // The same rule holds outdoors, whatever suspended the gate.
    leaveRoomByExit(world, 'bank');
    internals(world.session).inputGate.suspend();
    const outdoors = world.selected();
    world.press();
    expect(world.selected()).toBe(outdoors);
    internals(world.session).inputGate.resume();
    world.press();
    expect(world.selected()).toBe(pairedAvatarSprite(outdoors));
  });

  it('ignores held repeats and keystrokes aimed at an editable target', () => {
    const world = createWorld();
    world.start();

    world.keyboard.press({ repeat: true, target: null });
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { isContentEditable: true },
      { tagName: 'SPAN', closest: () => ({}) },
    ]) {
      world.keyboard.press({ repeat: false, target });
    }
    expect(world.selected()).toBe('avatar-1');
    expect(world.applied()).toEqual([]);

    world.press();
    expect(world.selected()).toBe('avatar-9');
  });

  it('stops toggling after destroy, including through a retained stale handler', () => {
    const world = createWorld();
    const session = world.start();
    world.press();
    expect(world.selected()).toBe('avatar-9');

    const stale = world.keyboard.snapshot();
    session.destroy();
    session.destroy();
    expect(world.keyboard.listenerCount()).toBe(0);

    world.press();
    stale({ repeat: false, target: null });
    expect(world.applied()).toEqual(['avatar-9']);
  });

  it('does not report a street tile after movement delivery retires the session', () => {
    const world = createWorld();
    const session = world.start();

    // A Shell/World listener can synchronously tear down the session while the
    // movement event is being delivered. The post-event tile report belongs
    // to that same session and must not enter a room after cleanup.
    place(session, streetTileCentre(doorTile('bank')));
    world.bus.once('player:moved', () => session.destroy());
    expect(() => tickHolding(world, { right: true })).not.toThrow();
    expect(world.bus.count('building:entered')).toBe(0);
    expect(world.tiles).toEqual([]);
  });

  it('ignores a stale session update after destroy', () => {
    const world = createWorld();
    const session = world.start();
    session.destroy();
    const movedBefore = world.bus.count('player:moved');
    const viewCallsBefore = world.view.calls.length;

    // The engine drops the session on teardown, but a queued frame can still
    // reach this public boundary. It must not publish from the retired session.
    world.keyboard.hold({ right: true });
    expect(() => session.update(16)).not.toThrow();
    expect(world.bus.count('player:moved')).toBe(movedBefore);
    expect(world.view.calls).toHaveLength(viewCallsBefore);
  });

  it('does not call the tile observer after door delivery retires the session', () => {
    const world = createWorld();
    const session = world.start();
    world.bus.once('building:entered', () => session.destroy());
    place(session, streetTileCentre(doorTile('bank')));

    expect(() => tick(world)).not.toThrow();
    expect(session.destroyed).toBe(true);
    expect(world.tiles).toEqual([]);
  });

  it('retries the tile observer after a failed movement handoff', () => {
    const world = createWorld();
    world.start();
    let fail = true;
    world.observeTiles(() => {
      if (fail) throw new Error('tile observer failed');
    });

    expect(() => tick(world)).toThrow('tile observer failed');

    fail = false;
    expect(() => tick(world)).not.toThrow();
    expect(world.tiles).toEqual([STREET.spawn, STREET.spawn]);
    // Committed now: an unchanged tile is not reported again.
    tick(world);
    expect(world.tiles).toHaveLength(2);
  });

  it('retries Avatar Studio entry after a failed transition on the same tile', () => {
    const world = createWorld();
    world.start();
    const studio = world.studio();
    const error = new Error('studio entry failed');
    const enter = vi.spyOn(studio, 'enter').mockImplementationOnce(() => {
      throw error;
    });
    place(world.session, streetTileCentre(STUDIO_ENTRANCE));

    expect(() => tick(world)).toThrow(error);
    expect(enter).toHaveBeenCalledOnce();
    expect(studio.state.inRoom).toBe(false);
    expect(world.session.area).toBe('street');

    expect(() => tick(world)).not.toThrow();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(studio.state.inRoom).toBe(true);
    expect(world.session.area).toBe('studio');
    world.session.destroy();
  });

  it('retries E at a counter after a failed station handoff (D-117)', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    makeBankStationAvailable(world);
    world.bus.failNext('station:activated', new Error('room tile handoff failed'));
    place(world.session, interiorTileCentre(BANK_APPROACH));
    // Standing at it opens nothing.
    tick(world);
    expect(world.bus.count('station:activated')).toBe(0);

    expect(() => world.keyboard.pressE()).toThrow('room tile handoff failed');
    // The failed activation handed the keyboard back rather than stranding it.
    expect(world.session.inputSuspended).toBe(false);

    expect(() => world.keyboard.pressE()).not.toThrow();
    expect(world.bus.count('station:activated')).toBe(2);
    // Standing on at the approach does not open it again.
    tick(world);
    expect(world.bus.count('station:activated')).toBe(2);
  });

  it('does not retain session Studio mode when presentation entry fails', () => {
    const world = createWorld();
    world.start();
    const error = new Error('studio presentation failed');
    world.view.failNext('syncStudio', error, (state) => state.visible);
    place(world.session, streetTileCentre(STUDIO_ENTRANCE));

    expect(() => tick(world)).toThrow(error);
    expect(world.studio().state.inRoom).toBe(false);
    expect(world.session.area).toBe('street');
    // The presentation restored the street it had started to hide.
    expect(world.view.last('setStreetVisible')).toEqual([true]);
    expect(world.view.last('setCameraBounds')).toEqual([STREET_BOUNDS]);

    enterStudioByEntrance(world);
    expect(world.studio().state.inRoom).toBe(true);
    world.session.destroy();
  });

  it('retains session Studio mode when presentation exit fails', () => {
    const world = createWorld();
    world.start();
    enterStudioByEntrance(world);
    const error = new Error('studio presentation exit failed');
    world.view.failNext('setStreetVisible', error, (visible) => visible);
    place(world.session, studioTileCentre(STUDIO_EXIT));

    expect(() => tickHolding(world, { down: true })).toThrow(error);
    expect(world.studio().state.inRoom).toBe(true);
    expect(world.session.area).toBe('studio');

    stepOntoStudioTile(world, STUDIO_EXIT);
    expect(world.studio().state.inRoom).toBe(false);
    expect(world.session.area).toBe('street');
    world.session.destroy();
  });

  it('retries fixed-room entry after a failed transition on the same tile', () => {
    const world = createWorld();
    world.start();
    const room = world.room('bank');
    const error = new Error('fixed-room entry failed');
    const enter = vi.spyOn(room, 'enter').mockImplementationOnce(() => {
      throw error;
    });
    place(world.session, streetTileCentre(doorTile('bank')));

    expect(() => tick(world)).toThrow(error);
    expect(enter).toHaveBeenCalledOnce();

    // The player remains on the same door tile. A failed room handoff must
    // remain retryable instead of being hidden by the session's tile sentinel.
    expect(() => tick(world)).not.toThrow();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(room.state.inRoom).toBe(true);
    expect(world.session.area).toBe('bank');
    world.session.destroy();
  });

  it('does not retain an active room when controller entry fails', () => {
    const world = createWorld();
    world.start();
    const error = new Error('fixed-room controller entry failed');
    vi.spyOn(world.room('bank'), 'enter').mockImplementationOnce(() => {
      throw error;
    });
    place(world.session, streetTileCentre(doorTile('bank')));

    expect(() => tick(world)).toThrow(error);
    expect(internals(world.session).activeRoom).toBeUndefined();
    expect(world.session.area).toBe('street');
    // The semantic event is published only after local entry succeeds.
    expect(world.bus.count('building:entered')).toBe(0);
    world.session.destroy();
  });

  it('rebinds the outfit toggle through the production create order when a new session replaces a destroyed one', () => {
    // The ordering under test lives in the constructor itself: the session
    // must make its selection *before* it builds the Studio. A session starts
    // out holding the no-op selection, so a swap would hand the Studio that
    // instead, which changes nothing visible until someone presses F.
    const world = createWorld();

    world.start();
    expect(world.cycles).toHaveLength(1);
    expect(world.keyboard.listenerCount()).toBe(1);
    expect(world.studio().state.selected).toBe('avatar-1');
    world.press();
    expect(world.applied(0)).toEqual(['avatar-9']);
    expect(world.studio().state.selected).toBe('avatar-9');

    const stale = world.keyboard.snapshot();
    world.session.destroy();
    expect(world.keyboard.listenerCount()).toBe(0);

    // The engine's rebind: destroy, then construct on the same keyboard and bus.
    world.start();
    expect(world.cycles).toHaveLength(2);
    expect(world.keyboard.listenerCount()).toBe(1);
    // A new session starts from the default, and its Studio must hold *this*
    // session's selection — not the destroyed one, and not the no-op.
    expect(world.studio().state.selected).toBe('avatar-1');

    world.press();
    expect(world.applied(1)).toEqual(['avatar-9']);
    expect(world.studio().state.selected).toBe('avatar-9');
    // The previous session's avatar was not driven by the new binding.
    expect(world.applied(0)).toEqual(['avatar-9']);

    // The first session's handler is inert even though it was captured while live.
    stale({ repeat: false, target: null });
    expect(world.applied(0)).toEqual(['avatar-9']);
    expect(world.applied(1)).toEqual(['avatar-9']);

    world.session.destroy();
    expect(world.keyboard.listenerCount()).toBe(0);
    world.press();
    expect(world.applied(1)).toEqual(['avatar-9']);
  });

  it('retires prior World ownership before a replacement session is created', () => {
    // The mounting regression the Scene guarded against: a second cycle must
    // replace every listener-owning controller, not only the outfit binding.
    const world = createWorld();
    const stale = world.start();
    enterBuilding(world, 'bank');
    const staleBank = world.room('bank');
    expect(staleBank.state.inRoom).toBe(true);
    // Three per room (the hidden room's too, D-107, and the arena's, D-114),
    // and the Privacy Plaza's control claim and figures (D-076).
    expect(world.bus.shellListenerCount()).toBe(20);

    stale.destroy();
    const replacement = world.start();

    expect(world.cycles).toHaveLength(2);
    expect(world.keyboard.listenerCount()).toBe(1);
    expect(staleBank.state.inRoom).toBe(false);
    expect(world.bus.shellListenerCount()).toBe(20);

    // A late Shell exit reaches only the current, outside controller. The
    // retired Bank must not move the new session or publish a stale exit.
    world.bus.shellEmit('world:exit-building', { building: 'bank' });
    expect(world.bus.count('building:exited')).toBe(0);
    expect(replacement.player).toEqual(streetTileCentre(STREET.spawn));

    world.press();
    expect(world.applied(1)).toEqual(['avatar-9']);
    expect(world.applied(0)).toEqual([]);

    replacement.destroy();
    expect(world.keyboard.listenerCount()).toBe(0);
    expect(world.bus.shellListenerCount()).toBe(0);
  });

  it('cleans every session once while repeated destroy stays idempotent', () => {
    const world = createWorld();

    for (let index = 0; index < 2; index += 1) {
      const session = world.start();
      // Leave each session holding a suspended keyboard, so its release is observable.
      enterBuilding(world, 'bank');
      world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
      expect(world.keyboard.enabled).toBe(false);
      const captures = world.keyboard.enableGlobalCapture.mock.calls.length;

      session.destroy();
      expect(session.destroyed).toBe(true);
      session.destroy();

      expect(world.keyboard.enabled).toBe(true);
      expect(world.keyboard.enableGlobalCapture.mock.calls.length - captures).toBe(1);
      expect(world.bus.shellListenerCount()).toBe(0);
      expect(world.keyboard.listenerCount()).toBe(0);
    }

    expect(world.cycles).toHaveLength(2);
    for (const cycle of world.cycles) expectCompleteCleanup(cycle);
  });

  it('does not expose cleaned prior-cycle resources to an early construction failure', () => {
    const world = createWorld();
    world.start();
    world.session.destroy();
    const completed = world.cycle(0);
    expectCompleteCleanup(completed);

    // The first view call of construction: nothing listener-owning exists yet.
    world.beforeNextStart((view) => view.failNext('setPlayerAvatar', new Error('early create failure')));
    expect(() => world.start()).toThrow('early create failure');
    const failed = world.cycle(1);
    expect(failed.session).toBeUndefined();
    expect(failed.view.count('destroy')).toBe(1);
    expect(failed.view.count('destroyStudio')).toBe(0);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
    expectCompleteCleanup(completed);

    const recovered = world.start();
    recovered.destroy();
    expectCompleteCleanup(world.cycle(2));
  });

  it('cleans partial resources when a later construction step throws', () => {
    const world = createWorld();
    world.start();
    world.session.destroy();
    const completed = world.cycle(0);
    expectCompleteCleanup(completed);

    // Fail the post-office room's first Shell subscription: the F binding and
    // three rooms already exist, the Studio does not.
    const error = new Error('partial create failure');
    world.bus.failShellSubscriptionAfter(9, error);
    const mark = world.journal.length;
    expect(() => world.start()).toThrow(error);
    const partial = world.cycle(1);
    const log = world.journal.slice(mark);

    expect(countEntries(log, 'shell.on:')).toBe(9);
    expect(countEntries(log, 'shell.off:')).toBe(9);
    expect(countEntries(log, 'keyboard.on:keydown-F')).toBe(1);
    expect(countEntries(log, 'keyboard.off:keydown-F')).toBe(1);
    expect(partial.view.count('destroyStudio')).toBe(0);
    expect(partial.view.count('destroy')).toBe(1);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
    expectCompleteCleanup(completed);

    const recovered = world.start();
    recovered.destroy();
    expectCompleteCleanup(world.cycle(2));
  });

  it('cleans a failed construction immediately, with no later shutdown to wait for', () => {
    const world = createWorld();
    const error = new Error('partial create failure');
    // The camera step: the binding, every room and the Studio already exist.
    world.beforeNextStart((view) => view.failNext('setCameraBounds', error));

    expect(() => world.start()).toThrow(error);

    const partial = world.cycle(0);
    expect(partial.session).toBeUndefined();
    expect(countEntries(world.journal, 'shell.off:')).toBe(18);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
    expectCompleteCleanup(partial);

    // Nothing escaped the constructor to be destroyed twice later, and the
    // same keyboard and bus still host a working session.
    const recovered = world.start();
    recovered.destroy();
    expectCompleteCleanup(world.cycle(1));
    expectCompleteCleanup(partial);
  });

  it('preserves the create error and continues cleanup when a destructor throws', () => {
    const world = createWorld();
    const createError = new Error('partial create failure');
    world.beforeNextStart((view) => {
      view.failNext('setCameraBounds', createError);
      view.failNext('destroyStudio', new Error('studio teardown failed'));
      view.failNext('destroy', new Error('view teardown failed'));
    });

    const thrown = thrownBy(() => world.start());

    expect(thrown).toBe(createError);
    const partial = world.cycle(0);
    expectCompleteCleanup(partial);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
  });

  it('propagates cleanup errors after attempting every teardown', () => {
    const world = createWorld();
    const session = world.start();
    const cleanupError = new Error('studio teardown failed');
    world.view.failNext('destroyStudio', cleanupError);

    expect(thrownBy(() => session.destroy())).toBe(cleanupError);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
    expect(world.view.count('destroy')).toBe(1);

    session.destroy();
    expectCompleteCleanup(world.cycle());
  });

  it('does not reuse a stale tile across sessions', () => {
    const world = createWorld();
    world.start();
    tick(world);
    expect(world.tiles).toEqual([STREET.spawn]);
    world.session.destroy();

    // A new session starts from the unset sentinel, so its first frame reports
    // the spawn tile again instead of treating it as unchanged.
    world.start();
    tick(world);
    expect(world.tiles).toEqual([STREET.spawn, STREET.spawn]);
    world.session.destroy();
  });
});

// ---------------------------------------------------------------------------
// Orchestration rules the Scene enforced in code but the suite did not name
// ---------------------------------------------------------------------------

describe('WorldSession orchestration', () => {
  it('constructs its collaborators in the production order', () => {
    const world = createWorld();
    world.start();
    const spawn = streetTileCentre(STREET.spawn);

    // Movement adapter before the player (the spawn sample is published), the
    // outfit binding before the rooms, the rooms before the camera, and the
    // interiors hidden last.
    expect(world.journal).toEqual([
      'view.setPlayerAvatar',
      'view.setPlayerPosition',
      'out:player:moved',
      'keyboard.on:keydown-F',
      ...ROOM_BUILDINGS.flatMap(() => [
        'shell.on:world:stations',
        'shell.on:world:control-owner',
        'shell.on:world:exit-building',
      ]),
      'view.setCameraBounds',
      'view.showRoom',
      'view.syncStudio',
      // The Privacy Plaza's stations (D-076), last: they need the input gate.
      'shell.on:world:control-owner',
      'shell.on:plaza:stats',
    ]);
    expect(world.view.calls).toEqual([
      { method: 'setPlayerAvatar', args: ['avatar-1'] },
      { method: 'setPlayerPosition', args: [spawn, true] },
      { method: 'setCameraBounds', args: [STREET_BOUNDS] },
      { method: 'showRoom', args: [null] },
      { method: 'syncStudio', args: [{ visible: false, highlightedFigure: null }] },
    ]);
    expect(world.bus.payloads('player:moved')).toEqual([{ position: spawn, facing: 'down' }]);

    // The Studio was handed the session's selection, built before it.
    world.press();
    expect(world.studio().state.selected).toBe('avatar-9');
    // The rooms were handed the live input gate, built before them.
    enterBuilding(world, 'bank');
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(world.keyboard.enabled).toBe(false);
  });

  it('boots headless without a bus or keyboard', () => {
    const world = createWorld({ config: false, keyboard: false });
    const session = world.start();
    expect(world.bus.emitted).toEqual([]);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);

    world.keyboard.hold({ right: true });
    session.update(16);
    expect(session.player).toEqual(streetTileCentre(STREET.spawn));
    expect(world.view.last('setPlayerMotion')).toEqual([IDLE_MOTION]);
    expect(session.inputSuspended).toBe(false);
    expect(world.tiles).toEqual([STREET.spawn]);

    session.destroy();
    expect(world.view.count('destroy')).toBe(1);
  });

  it('emits player:moved on every street frame before reporting the tile', () => {
    const world = createWorld();
    world.start();
    const movedAtReport: number[] = [];
    world.observeTiles(() => movedAtReport.push(world.bus.count('player:moved')));

    tick(world);
    tick(world);
    tick(world);
    // The spawn sample plus one per frame, standing still or not.
    expect(world.bus.count('player:moved')).toBe(4);
    // The first frame's sample precedes its tile report; unchanged tiles are
    // not reported again.
    expect(movedAtReport).toEqual([2]);

    tickHolding(world, { right: true }, MAX_SESSION_FRAME_MS);
    expect(world.tiles).toEqual([STREET.spawn, { x: STREET.spawn.x + 1, y: STREET.spawn.y }]);
    expect(movedAtReport).toEqual([2, 5]);
  });

  it('keeps the door tile committed while its handoff is delivered', () => {
    const world = createWorld();
    const session = world.start();
    const bank = world.room('bank');
    const enterForReal = bank.enter;
    vi.spyOn(bank, 'enter').mockImplementationOnce(() => {
      // A nested frame while the player still stands on the door tile must
      // not report that tile a second time.
      session.update(16);
      enterForReal();
    });
    place(session, streetTileCentre(doorTile('bank')));

    tick(world);

    expect(world.tiles).toEqual([doorTile('bank')]);
    expect(session.area).toBe('bank');
  });

  it('rolls back only its own door tile commit when a nested report took over', () => {
    const world = createWorld();
    const session = world.start();
    const error = new Error('entry consumer failed');
    world.bus.once('building:entered', () => {
      // The Shell runs a frame inside the room, then rejects the entry event.
      session.update(16);
      throw error;
    });
    place(session, streetTileCentre(doorTile('bank')));

    expect(() => tick(world)).toThrow(error);
    // The nested room frame committed the Bank spawn tile. The failed outer
    // report must not restore its older street sentinel over it.
    expect(internals(session).lastTile).toEqual(FIXED_ROOM_DEFINITIONS.bank.spawn);
    expect(session.area).toBe('bank');
  });

  it('does not roll back the tile sentinel after the tile observer retires the session', () => {
    const world = createWorld();
    const session = world.start();
    const error = new Error('tile observer failed');
    world.observeTiles(() => {
      session.destroy();
      throw error;
    });

    expect(() => tick(world)).toThrow(error);
    expect(session.destroyed).toBe(true);
    expect(internals(session).lastTile).toEqual(STREET.spawn);
  });

  it('does not commit the Studio entrance after entry retires the session', () => {
    const world = createWorld();
    const session = world.start();
    world.bus.once('avatar-studio:entered', () => session.destroy());
    place(session, streetTileCentre(STUDIO_ENTRANCE));

    expect(() => tick(world)).not.toThrow();
    expect(session.destroyed).toBe(true);
    expect(internals(session).lastTile).toEqual({ x: -1, y: -1 });
  });

  it('hands the keyboard back by teardown when E\'s station delivery retires the session (D-117)', () => {
    const world = createWorld();
    const session = world.start();
    enterBuilding(world, 'bank');
    makeBankStationAvailable(world);
    const error = new Error('station consumer failed');
    world.bus.once('station:activated', () => {
      session.destroy();
      throw error;
    });
    place(session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    expect(internals(session).lastTile).toEqual(BANK_APPROACH);

    expect(() => world.keyboard.pressE()).toThrow(error);
    expect(session.destroyed).toBe(true);
    // Teardown, not the retired activation, handed the keyboard back.
    expect(world.keyboard.enabled).toBe(true);
  });

  it('moves the player in a room only while the World owns control', () => {
    const world = createWorld();
    const session = world.start();
    enterBuilding(world, 'bank');
    const inside = session.player;

    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    // Even a keyboard that leaks held keys cannot move a Shell-owned room.
    world.keyboard.leaksWhileDisabled = true;
    tickHolding(world, { up: true });
    expect(session.player).toEqual(inside);
    expect(world.view.last('setPlayerMotion')).toEqual([IDLE_MOTION]);

    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    tickHolding(world, { up: true });
    expect(session.player).toEqual({ x: inside.x, y: inside.y - WALK_STEP });
  });

  it('reports Studio tiles only after a non-zero move', () => {
    const world = createWorld();
    const session = world.start();
    enterStudioByEntrance(world);
    // Figure 3 stands on Studio tile (8, 3).
    place(session, studioTileCentre({ x: 8, y: 3 }));

    tick(world);
    expect(world.selected()).toBe('avatar-1');
    expect(world.studio().state.highlightedFigure).toBeNull();

    tickHolding(world, { down: true });
    expect(world.selected()).toBe('avatar-1');
    expect(world.studio().state.highlightedFigure).toBe(3);
    expect(world.view.last('syncStudio')).toEqual([{ visible: true, highlightedFigure: 3 }]);
    world.keyboard.pressE();
    expect(world.selected()).toBe('avatar-3');

    // Walking on never reselects figure 3 over the toggled outfit (D-117).
    world.press();
    expect(world.selected()).toBe('avatar-11');
    tickHolding(world, { down: true });
    expect(world.selected()).toBe('avatar-11');
  });

  it('sets the active room before room entry and before publishing the entry', () => {
    const world = createWorld();
    const session = world.start();
    let areaWhenPublished: string | undefined;
    world.bus.once('building:entered', () => {
      areaWhenPublished = session.area;
    });
    const mark = world.journal.length;

    enterBuilding(world, 'bank');

    // The Shell's synchronous response must not race an outside controller.
    expect(areaWhenPublished).toBe('bank');
    // Rendering bails without an active room, so a render during entry proves
    // the room was claimed before `enter()` ran.
    const log = world.journal.slice(mark);
    expect(log.indexOf('view.renderRoom')).toBeGreaterThan(-1);
    expect(log.indexOf('view.renderRoom')).toBeLessThan(log.indexOf('out:building:entered'));
  });

  it('returns a failed room presentation to the street at the door return tile', () => {
    const world = createWorld();
    const session = world.start();
    const error = new Error('room presentation failed');
    world.view.failNext('showRoom', error, (building) => building === 'bank');
    place(session, streetTileCentre(doorTile('bank')));

    expect(() => tick(world)).toThrow(error);

    // Both the presentation's restore and the controller's compensation read
    // the return tile, so it was set before `enter()` ran.
    expect(session.player).toEqual(streetTileCentre(returnTile('bank')));
    expect(session.area).toBe('street');
    expect(world.room('bank').state.inRoom).toBe(false);
    expect(world.bus.count('building:entered')).toBe(0);
    expect(world.view.last('setStreetVisible')).toEqual([true]);
    expect(world.view.last('showRoom')).toEqual([null]);
    expect(world.view.last('setCameraBounds')).toEqual([STREET_BOUNDS]);

    // The door stays usable.
    enterBuilding(world, 'bank');
  });

  it('clears the active room only while it still belongs to the failed entry', () => {
    const world = createWorld();
    const session = world.start();
    const error = new Error('bank entry failed');
    vi.spyOn(world.room('bank'), 'enter').mockImplementationOnce(() => {
      // A nested frame walks the player through the Exchange door while the
      // Bank handoff is still in flight, then the Bank handoff fails.
      place(session, streetTileCentre(doorTile('exchange')));
      session.update(16);
      throw error;
    });
    place(session, streetTileCentre(doorTile('bank')));

    expect(() => tick(world)).toThrow(error);
    expect(world.room('exchange').state.inRoom).toBe(true);
    expect(internals(session).activeRoom).toBe('exchange');
    expect(session.area).toBe('exchange');
  });

  it('resumes World input before publishing a door-trigger exit', () => {
    const world = createWorld();
    const session = world.start();
    // A controller that leaves the player on the street keeps the Bank door
    // zone occupied, so stepping off it emits the trigger's own exit.
    vi.spyOn(world.room('bank'), 'enter').mockImplementation(() => {});
    place(session, streetTileCentre(doorTile('bank')));
    tick(world);
    expect(world.bus.count('building:entered')).toBe(1);

    internals(session).inputGate.suspend();
    expect(session.inputSuspended).toBe(true);
    let suspendedWhenPublished: boolean | undefined;
    world.bus.once('building:exited', () => {
      suspendedWhenPublished = session.inputSuspended;
    });
    place(session, streetTileCentre(returnTile('bank')));
    tick(world);

    expect(world.bus.payloads('building:exited')).toEqual([{ building: 'bank' }]);
    expect(suspendedWhenPublished).toBe(false);
    expect(world.keyboard.enabled).toBe(true);
  });

  it('switches Studio mode before each presentation handoff', () => {
    const world = createWorld();
    const session = world.start();
    const areas: string[] = [];
    world.view.once('setStreetVisible', () => areas.push(session.area), (visible) => !visible);
    enterStudioByEntrance(world);
    world.view.once('setStreetVisible', () => areas.push(session.area), (visible) => visible);
    stepOntoStudioTile(world, STUDIO_EXIT);

    expect(areas).toEqual(['studio', 'street']);
    expect(session.area).toBe('street');
  });

  it('does not restore Studio mode after a failed exit retires the session', () => {
    const world = createWorld();
    const session = world.start();
    enterStudioByEntrance(world);
    const error = new Error('street presentation failed');
    world.view.once(
      'setStreetVisible',
      () => {
        session.destroy();
        throw error;
      },
      (visible) => visible,
    );
    place(session, studioTileCentre(STUDIO_EXIT));

    expect(() => tickHolding(world, { down: true })).toThrow(error);
    expect(session.destroyed).toBe(true);
    expect(session.area).toBe('street');
  });

  it('applies the outfit visual before publishing the selection', () => {
    const world = createWorld();
    world.start();
    let wornWhenPublished: AvatarSpriteKey | undefined;
    world.bus.once('avatar:selected', () => {
      wornWhenPublished = world.view.avatars().at(-1);
    });
    const mark = world.journal.length;

    world.press();

    expect(wornWhenPublished).toBe('avatar-9');
    expect(world.journal.slice(mark)).toEqual(['view.setPlayerAvatar', 'out:avatar:selected']);
    expect(world.bus.payloads('avatar:selected')).toEqual([{ sprite: 'avatar-9' }]);
  });

  it('keeps a newer reentrant selection when the outer selection delivery fails', () => {
    const world = createWorld();
    world.start();
    const error = new Error('selection consumer failed');
    world.bus.once('avatar:selected', () => {
      // The Shell toggles twice while handling the first selection, then
      // rejects it. Reverting the visual now would undo the newer selection.
      world.press();
      world.press();
      throw error;
    });

    expect(() => world.press()).toThrow(error);
    expect(world.applied()).toEqual(['avatar-9', 'avatar-1', 'avatar-9']);
    expect(world.selected()).toBe('avatar-9');
  });

  it('aggregates multiple teardown failures after attempting every step', () => {
    const world = createWorld();
    const session = world.start();
    const studioError = new Error('studio teardown failed');
    const viewError = new Error('view teardown failed');
    world.view.failNext('destroyStudio', studioError);
    world.view.failNext('destroy', viewError);

    const thrown = thrownBy(() => session.destroy());

    expect(thrown).toBeInstanceOf(AggregateError);
    const { errors } = thrown as AggregateError;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(studioError);
    expect(errors[1]).toBe(viewError);
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
    expect(session.destroyed).toBe(true);
    expect(() => session.destroy()).not.toThrow();
  });

  it('resumes World input at teardown even when every room fails to restore it', () => {
    const world = createWorld();
    const session = world.start();
    enterBuilding(world, 'bank');
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(session.inputSuspended).toBe(true);
    const captureError = new Error('capture restore failed');
    for (const _ of ROOM_BUILDINGS) {
      world.keyboard.enableGlobalCapture.mockImplementationOnce(() => {
        throw captureError;
      });
    }

    const thrown = thrownBy(() => session.destroy());

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual(ROOM_BUILDINGS.map(() => captureError));
    // The session's own gate resume ran after every room's attempt failed.
    expect(world.keyboard.enableGlobalCapture).toHaveBeenCalledTimes(ROOM_BUILDINGS.length + 1);
    expect(world.keyboard.enabled).toBe(true);
    // The no-op gate is swapped in either way.
    expect(session.inputSuspended).toBe(false);
    expectCompleteCleanup(world.cycle());
    expect(world.bus.shellListenerCount()).toBe(0);
    expect(world.keyboard.listenerCount()).toBe(0);
  });

  it('retires its input gate at teardown even when the keyboard cannot be restored', () => {
    const world = createWorld();
    const session = world.start();
    enterBuilding(world, 'bank');
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    const captureError = new Error('capture restore failed');
    world.keyboard.enableGlobalCapture.mockImplementation(() => {
      throw captureError;
    });

    const thrown = thrownBy(() => session.destroy());

    // Every room, then the session itself, tried and failed to restore input.
    expect(thrown).toBeInstanceOf(AggregateError);
    const { errors } = thrown as AggregateError;
    expect(errors).toHaveLength(ROOM_BUILDINGS.length + 1);
    expect(errors.every((error) => error === captureError)).toBe(true);
    // The retired session swapped in the no-op gate rather than answering for
    // the live one.
    expect(session.inputSuspended).toBe(false);
  });

  it('prompts at the Bank counter when it becomes available under a player already at it, and opens it only on E (D-117)', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    place(world.session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    expect(world.bus.payloads('station:activated')).toEqual([]);
    expect(world.session.interactionPrompt).toBeNull();
    // Standing still, no tile change: the snapshot brings up the prompt, not the window.
    makeBankStationAvailable(world);
    expect(world.bus.payloads('station:activated')).toEqual([]);
    tick(world);
    expect(world.session.interactionPrompt).toMatchObject({ id: BANK_STATION.station, label: 'SHIELD' });
    expect(world.view.last('setInteractionPrompt')).toEqual([world.session.interactionPrompt]);
    expect(world.bus.payloads('station:activated')).toEqual([]);
    world.keyboard.pressE();
    expect(world.bus.payloads('station:activated')).toEqual([{ building: 'bank', station: BANK_STATION.station }]);
  });

  it('hands the active room station presentations to the view', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    // The Bank's other three counters ride along, locked: the Shell has not
    // switched them on (D-063, D-103).
    const others = FIXED_ROOM_DEFINITIONS.bank.stations.slice(1).map((station) => ({ ...station, status: 'locked', highlighted: false, notice: false }));
    expect(world.view.last('renderRoom')).toEqual([
      'bank',
      [{ ...BANK_STATION, status: 'locked', highlighted: false, notice: false }, ...others],
    ]);

    makeBankStationAvailable(world);
    expect(world.view.last('renderRoom')).toEqual([
      'bank',
      [{ ...BANK_STATION, label: 'SHIELD', status: 'available', highlighted: false, notice: false }, ...others],
    ]);

    place(world.session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    expect(world.view.last('renderRoom')).toEqual([
      'bank',
      [{ ...BANK_STATION, label: 'SHIELD', status: 'available', highlighted: true, notice: false }, ...others],
    ]);
    // Highlighted, not opened (D-117).
    expect(world.bus.payloads('station:activated')).toEqual([]);

    // A retired room is hidden, not rendered again.
    const renders = world.view.count('renderRoom');
    leaveRoomByExit(world, 'bank');
    expect(world.view.last('showRoom')).toEqual([null]);
    expect(world.view.count('renderRoom')).toBe(renders);
  });
});

// ---------------------------------------------------------------------------
// Camera: the renderer-independent part of the StreetScene camera suite
// ---------------------------------------------------------------------------

// Follow lerp and zoom belong to the Three camera rig now; the bounds are
// still the session's to decide.
describe('WorldSession camera', () => {
  it('bounds the camera to the whole street, then to each interior', () => {
    const world = createWorld();
    world.start();
    expect(world.view.argsOf('setCameraBounds')).toEqual([[STREET_BOUNDS]]);

    enterBuilding(world, 'bank');
    expect(world.view.last('setCameraBounds')).toEqual([INTERIOR_BOUNDS]);
    leaveRoomByExit(world, 'bank');
    expect(world.view.last('setCameraBounds')).toEqual([STREET_BOUNDS]);

    enterStudioByEntrance(world);
    expect(world.view.last('setCameraBounds')).toEqual([INTERIOR_BOUNDS]);
    stepOntoStudioTile(world, STUDIO_EXIT);
    expect(world.view.last('setCameraBounds')).toEqual([STREET_BOUNDS]);
  });
});

// ---------------------------------------------------------------------------
// D-059: camera-relative movement through tile-authored collision
// ---------------------------------------------------------------------------

describe('rotateScreenVelocity', () => {
  it('is the identity for the north-up camera', () => {
    const velocity = { x: 3, y: -4 };
    expect(rotateScreenVelocity(velocity, 0)).toEqual(velocity);
  });

  it('turns screen up to west and screen right to north after a quarter orbit', () => {
    const up = rotateScreenVelocity({ x: 0, y: -PLAYER_WALK_SPEED }, Math.PI / 2);
    expect(up.x).toBeCloseTo(-PLAYER_WALK_SPEED, 9);
    expect(up.y).toBeCloseTo(0, 9);

    const right = rotateScreenVelocity({ x: PLAYER_WALK_SPEED, y: 0 }, Math.PI / 2);
    expect(right.x).toBeCloseTo(0, 9);
    expect(right.y).toBeCloseTo(-PLAYER_WALK_SPEED, 9);
  });

  it('preserves speed at any yaw', () => {
    for (const yaw of [0.3, 1, Math.PI / 2, 2.5, Math.PI, -1.2, 7]) {
      const rotated = rotateScreenVelocity({ x: 120, y: -90 }, yaw);
      expect(Math.hypot(rotated.x, rotated.y)).toBeCloseTo(150, 9);
    }
  });

  it('treats a non-finite yaw as north-up', () => {
    for (const yaw of [Number.NaN, Infinity, -Infinity]) {
      expect(rotateScreenVelocity({ x: 1, y: 2 }, yaw)).toEqual({ x: 1, y: 2 });
    }
  });
});

describe('cardinalMovementInput', () => {
  it('resolves an exact diagonal vertically', () => {
    expect(cardinalMovementInput({ x: 1, y: 1 })).toEqual({ ...NO_KEYS, down: true });
    expect(cardinalMovementInput({ x: -1, y: -1 })).toEqual({ ...NO_KEYS, up: true });
  });

  it('reads the dominant axis otherwise', () => {
    expect(cardinalMovementInput({ x: -2, y: 1 })).toEqual({ ...NO_KEYS, left: true });
    expect(cardinalMovementInput({ x: 1, y: -2 })).toEqual({ ...NO_KEYS, up: true });
  });

  it('reads a stopped or non-finite velocity as no direction', () => {
    expect(cardinalMovementInput({ x: 0, y: 0 })).toEqual(NO_KEYS);
    expect(cardinalMovementInput({ x: Number.NaN, y: 1 })).toEqual(NO_KEYS);
  });
});

describe('WorldSession movement (D-059)', () => {
  it('publishes the World direction as the wire facing under a rotated camera', () => {
    const world = createWorld();
    const session = world.start();
    const start = session.player;

    // A quarter orbit: screen up walks west.
    tickHolding(world, { up: true }, 16, { cameraYaw: Math.PI / 2 });
    expect(session.facing).toBe('left');
    expect(world.bus.payloads('player:moved').at(-1)?.facing).toBe('left');
    expect(session.player.x).toBeCloseTo(start.x - WALK_STEP, 9);
    expect(session.player.y).toBeCloseTo(start.y, 9);
    const motion = world.view.last('setPlayerMotion')?.[0];
    expect(motion?.vx).toBeCloseTo(-PLAYER_WALK_SPEED, 9);
    expect(motion?.vy).toBeCloseTo(0, 9);

    // Screen right walks north.
    tickHolding(world, { right: true }, 16, { cameraYaw: Math.PI / 2 });
    expect(world.bus.payloads('player:moved').at(-1)?.facing).toBe('up');

    // Half an orbit: screen up walks south.
    tickHolding(world, { up: true }, 16, { cameraYaw: Math.PI });
    expect(world.bus.payloads('player:moved').at(-1)?.facing).toBe('down');

    // An unusable yaw falls back to north-up.
    tickHolding(world, { left: true }, 16, { cameraYaw: Number.NaN });
    expect(world.bus.payloads('player:moved').at(-1)?.facing).toBe('left');
  });

  it('walks from the spawn through the door gap straight ahead and enters that building', () => {
    const world = createWorld();
    const session = world.start();
    const ahead = STREET.doors.find(
      (door) => STREET.spawn.x >= door.x && STREET.spawn.x < door.x + door.width,
    );
    expect(ahead?.building).toBe('post-office');

    world.keyboard.hold({ up: true });
    for (let frame = 0; frame < 30 && session.area === 'street'; frame += 1) {
      session.update(MAX_SESSION_FRAME_MS);
    }
    world.keyboard.release();

    expect(session.area).toBe('post-office');
    expect(world.bus.payloads('building:entered')).toEqual([{ building: 'post-office' }]);
  });

  it('blocks movement at the facade outside the door gap', () => {
    const world = createWorld();
    const session = world.start();
    // Pavement below solid facade, one column east of the Bank door gap.
    const bank = doorTile('bank');
    const belowFacade = { x: bank.x + 2, y: bank.y + 1 };
    expect(isSolidAt(STREET, belowFacade.x, belowFacade.y - 1)).toBe(true);
    place(session, streetTileCentre(belowFacade));

    world.keyboard.hold({ up: true });
    for (let frame = 0; frame < 20; frame += 1) session.update(MAX_SESSION_FRAME_MS);
    world.keyboard.release();

    expect(worldToTile(session.player.x, session.player.y)).toEqual(belowFacade);
    // The body never overlaps the facade row.
    expect(session.player.y - AVATAR_BODY_SIZE / 2).toBeGreaterThanOrEqual(belowFacade.y * TILE_SIZE);
    expect(session.player.x).toBe(streetTileCentre(belowFacade).x);
    expect(world.bus.count('building:entered')).toBe(0);
    expect(world.bus.count('building:locked')).toBe(0);
  });

  it('reaches the hidden Studio entrance at the south edge and enters the Studio', () => {
    const world = createWorld();
    const session = world.start();

    world.keyboard.hold({ down: true });
    for (let frame = 0; frame < 60 && session.area === 'street'; frame += 1) {
      session.update(MAX_SESSION_FRAME_MS);
    }
    world.keyboard.release();

    expect(session.area).toBe('studio');
    expect(world.bus.count('avatar-studio:entered')).toBe(1);
    expect(world.view.last('setPlayerPosition')).toEqual([STUDIO_SPAWN, true]);
  });

  it('never leaves the street bounds', () => {
    const world = createWorld();
    const session = world.start();
    const walk = (keys: Partial<MovementInput>): void => {
      world.keyboard.hold(keys);
      for (let frame = 0; frame < 120; frame += 1) {
        // A stalled tab reports a huge frame; it must not tunnel out either.
        session.update(10_000);
        const { x, y } = session.player;
        expect(x - AVATAR_BODY_SIZE / 2).toBeGreaterThanOrEqual(0);
        expect(x + AVATAR_BODY_SIZE / 2).toBeLessThanOrEqual(STREET_BOUNDS.width);
        expect(y - AVATAR_BODY_SIZE / 2).toBeGreaterThanOrEqual(0);
        expect(y + AVATAR_BODY_SIZE / 2).toBeLessThanOrEqual(STREET_BOUNDS.height);
        expect(session.area).toBe('street');
      }
      world.keyboard.release();
    };

    // North-west corner, through open grass west of the Bank.
    place(session, streetTileCentre({ x: 1, y: STREET.spawn.y }));
    walk({ up: true });
    walk({ left: true });
    walk({ up: true, left: true });
    expect(worldToTile(session.player.x, session.player.y)).toEqual({ x: 0, y: 0 });

    // South-east corner, away from the Studio path.
    place(session, streetTileCentre({ x: STREET.width - 2, y: 20 }));
    walk({ down: true });
    walk({ right: true });
    walk({ down: true, right: true });
    expect(worldToTile(session.player.x, session.player.y)).toEqual({
      x: STREET.width - 1,
      y: STREET.height - 1,
    });
  });

  it('holds a stray position inside the active area, as the physics world bound did', () => {
    const world = createWorld();
    const session = world.start();
    // Walking cannot leave an area, because everything outside it is solid.
    // The bound is the backstop for a position that arrives from elsewhere.
    place(session, { x: -40, y: streetTileCentre(STREET.spawn).y });
    tickHolding(world, { right: true });
    expect(session.player.x).toBe(STREET_BOUNDS.x);

    const interiorEast = INTERIOR_BOUNDS.x + INTERIOR_BOUNDS.width;
    enterBuilding(world, 'bank');
    place(session, { x: interiorEast + 40, y: session.player.y });
    tickHolding(world, { left: true });
    expect(session.player.x).toBe(interiorEast);

    leaveRoomByExit(world, 'bank');
    enterStudioByEntrance(world);
    place(session, { x: interiorEast + 40, y: session.player.y });
    tickHolding(world, { left: true });
    expect(session.player.x).toBe(interiorEast);
  });

  it('does not move the player on a NaN or negative frame', () => {
    const world = createWorld();
    const session = world.start();
    const start = session.player;

    world.keyboard.hold({ right: true });
    for (const delta of [Number.NaN, -16, -Infinity]) {
      session.update(delta);
      expect(session.player).toEqual(start);
    }
    world.keyboard.release();

    for (const { position } of world.view.positions()) {
      expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
    }
  });

  it('clamps a huge frame to MAX_SESSION_FRAME_MS', () => {
    const world = createWorld();
    const session = world.start();
    const start = session.player;
    const clampedStep = (PLAYER_WALK_SPEED * MAX_SESSION_FRAME_MS) / 1000;

    tickHolding(world, { right: true }, 60_000);
    expect(session.player).toEqual({ x: start.x + clampedStep, y: start.y });

    // Infinity is not a frame length either; whatever it is read as, it
    // cannot warp the player.
    const before = session.player;
    tickHolding(world, { right: true }, Infinity);
    expect(session.player.x - before.x).toBeLessThanOrEqual(clampedStep);
    expect(session.player.y).toBe(before.y);
  });

  it('mirrors the input gate through inputSuspended', () => {
    const world = createWorld();
    const session = world.start();
    expect(session.inputSuspended).toBe(false);

    enterBuilding(world, 'bank');
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(session.inputSuspended).toBe(true);
    expect(world.keyboard.enabled).toBe(false);

    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    expect(session.inputSuspended).toBe(false);
    expect(world.keyboard.enabled).toBe(true);

    // Destroyed while suspended: the keyboard comes back, and the no-op gate
    // reads as not suspended.
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(session.inputSuspended).toBe(true);
    session.destroy();
    expect(session.inputSuspended).toBe(false);
    expect(world.keyboard.enabled).toBe(true);

    // Without a keyboard there is nothing to suspend.
    expect(createWorld({ keyboard: false }).start().inputSuspended).toBe(false);
  });

  it('reports the active area through every transition', () => {
    const world = createWorld();
    const session = world.start();
    expect(session.area).toBe('street');

    enterBuilding(world, 'bank');
    leaveRoomByExit(world, 'bank');

    enterBuilding(world, 'exchange');
    world.bus.shellEmit('world:exit-building', { building: 'exchange' });
    expect(session.area).toBe('street');

    enterStudioByEntrance(world);
    stepOntoStudioTile(world, STUDIO_EXIT);
    expect(session.area).toBe('street');

    enterBuilding(world, 'post-office');
    session.destroy();
    expect(session.area).toBe('street');
  });

  it('snaps the view for the spawn and every room or Studio handoff, and steps otherwise', () => {
    const world = createWorld();
    world.start();
    const spawn = streetTileCentre(STREET.spawn);
    const bankSpawn = interiorTileCentre(FIXED_ROOM_DEFINITIONS.bank.spawn);
    const studioExit = studioTileCentre(STUDIO_EXIT);

    tickHolding(world, { right: true });
    enterBuilding(world, 'bank');
    tickHolding(world, { up: true });
    leaveRoomByExit(world, 'bank');
    enterStudioByEntrance(world);
    tickHolding(world, { down: true });
    stepOntoStudioTile(world, STUDIO_EXIT);

    expect(world.view.positions()).toEqual([
      { position: spawn, snap: true },
      { position: { x: spawn.x + WALK_STEP, y: spawn.y }, snap: false },
      { position: bankSpawn, snap: true },
      { position: { x: bankSpawn.x, y: bankSpawn.y - WALK_STEP }, snap: false },
      { position: streetTileCentre(returnTile('bank')), snap: true },
      { position: STUDIO_SPAWN, snap: true },
      { position: { x: STUDIO_SPAWN.x, y: STUDIO_SPAWN.y + WALK_STEP }, snap: false },
      { position: { x: studioExit.x, y: studioExit.y + WALK_STEP }, snap: false },
      // D-125: outside the Studio's entrance, not back at the street spawn.
      { position: streetTileCentre(STUDIO_RETURN), snap: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The Exchange tower: three floors behind one door
// ---------------------------------------------------------------------------

const TOWER_FLOORS: Readonly<Record<FixedRoomLevelId, FixedRoomLevelMap>> = {
  ground: createFixedRoom(FIXED_ROOM_DEFINITIONS.exchange),
  degen: createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL),
  roof: createFixedRoomLevel(EXCHANGE_ROOF_LEVEL),
};
const ROOF = EXCHANGE_ROOF_LEVEL.rooftop;

/** A floor tile's centre in World pixels: interiors at the room origin, the roof over the tower. */
function floorTileCentre(level: FixedRoomLevelId, tile: Point): { x: number; y: number } {
  if (level !== 'roof') return interiorTileCentre(tile);
  return { x: (ROOF.x + tile.x) * TILE_SIZE + TILE_SIZE / 2, y: (ROOF.y + tile.y) * TILE_SIZE + TILE_SIZE / 2 };
}

function liftTo(from: FixedRoomLevelId, to: FixedRoomLevelId) {
  const lift = TOWER_FLOORS[from].lifts.find((candidate) => candidate.to === to);
  if (!lift) throw new Error(`No lift from ${from} to ${to}`);
  return lift;
}

/** Step onto the current floor's pad to `to`, the way a tile report finds it. */
function ride(world: World, to: FixedRoomLevelId): void {
  const from = world.session.level;
  if (!from) throw new Error('Not in the tower');
  place(world.session, floorTileCentre(from, liftTo(from, to)));
  tick(world);
  expect(world.session.level).toBe(to);
}

const FLOOR_ORDER: readonly FixedRoomLevelId[] = ['ground', 'degen', 'roof'];

/** In through the Exchange door if outside, then by lift, floor by floor, to `level`. */
function climbTo(world: World, level: FixedRoomLevelId): void {
  if (world.session.area !== 'exchange') enterBuilding(world, 'exchange');
  while (world.session.level !== level) {
    const here = FLOOR_ORDER.indexOf(world.session.level!);
    ride(world, FLOOR_ORDER[here + Math.sign(FLOOR_ORDER.indexOf(level) - here)]!);
  }
}

const KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1],
];
const keysFor = ([dx, dy]: readonly [number, number]): Partial<MovementInput> => ({
  left: dx < 0,
  right: dx > 0,
  up: dy < 0,
  down: dy > 0,
});

describe('WorldSession: counters built into their rooms', () => {
  it.each(['post-office', 'bridge', 'exchange'] as const)('never lets a player into the %s counter\'s furniture', (building) => {
    const world = createWorld();
    const session = world.start();
    const map = createFixedRoom(FIXED_ROOM_DEFINITIONS[building]);
    const station = map.stations[0]!;
    // Every free tile along the counter's front row, walking north, north-west and north-east into it.
    const half = AVATAR_BODY_SIZE / 2 - 0.5;
    let checked = 0;
    for (let x = 1; x < map.width - 1; x++) {
      if (isFixedRoomSolidAt(map, x, station.y + 1)) continue;
      for (const direction of [[0, -1], [-1, -1], [1, -1]] as const) {
        if (session.area !== building) enterBuilding(world, building);
        // A diagonal can carry the player onto the Exchange's lift; ride back down.
        if (session.level !== 'ground') climbTo(world, 'ground');
        place(session, interiorTileCentre({ x, y: station.y + 1 }));
        tick(world);
        world.keyboard.hold(keysFor(direction));
        for (let i = 0; i < 45 && session.area === building; i++) {
          tick(world);
          if (session.level !== 'ground') break;
          for (const [dx, dy] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) {
            const tile = {
              x: Math.floor((session.player.x + dx - ROOM_ORIGIN.x) / FIXED_ROOM_TILE_SIZE),
              y: Math.floor((session.player.y + dy - ROOM_ORIGIN.y) / FIXED_ROOM_TILE_SIZE),
            };
            expect(isFixedRoomSolidAt(map, tile.x, tile.y), `${building} ${x} ${direction} -> ${tile.x},${tile.y}`).toBe(false);
          }
          checked += 1;
        }
        world.keyboard.release();
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe('WorldSession: the Exchange tower', () => {
  it('rides the lift to the Degen floor and back while the Shell sees one building', () => {
    const world = createWorld();
    const session = world.start();
    enterBuilding(world, 'exchange');
    expect(session.level).toBe('ground');
    const moved = world.bus.count('player:moved');
    world.view.calls.length = 0;

    ride(world, 'degen');
    expect(session.area).toBe('exchange');
    // Out of the degen floor's lift down, beside its pad, in its interior.
    expect(session.player).toEqual(interiorTileCentre(liftTo('degen', 'ground').arrival));
    expect(world.view.last('showRoom')).toEqual(['exchange', 'degen']);
    expect(world.view.last('setCameraBounds')).toEqual([INTERIOR_BOUNDS]);
    expect(world.view.last('setStreetVisible')).toEqual([false]);
    expect(world.view.positions().at(-1)).toEqual({ position: session.player, snap: true });
    // The counter up here is its own, and locked until the Shell says otherwise.
    const degen = world.view.last('renderRoom')!;
    expect(degen[0]).toBe('exchange');
    expect(degen[1].map(({ station, status }) => ({ station, status }))).toEqual([
      { station: EXCHANGE_DEGEN_STATION, status: 'locked' },
    ]);
    // Indoors the roof is never mentioned.
    expect(world.view.count('showRooftop')).toBe(0);

    ride(world, 'ground');
    expect(session.player).toEqual(interiorTileCentre(liftTo('ground', 'degen').arrival));
    expect(world.view.last('showRoom')).toEqual(['exchange']);
    // Nothing crossed the seam: one entry, no exit, no presence.
    expect(world.bus.count('building:entered')).toBe(1);
    expect(world.bus.count('building:exited')).toBe(0);
    expect(world.bus.count('station:activated')).toBe(0);
    expect(world.bus.count('player:moved')).toBe(moved);
  });

  it('rides up to the real roof: the street stays drawn below and the camera looks down', () => {
    const world = createWorld();
    const session = world.start();
    climbTo(world, 'degen');
    world.view.calls.length = 0;

    ride(world, 'roof');
    const arrival = floorTileCentre('roof', liftTo('roof', 'degen').arrival);
    const roofBounds = { x: ROOF.x * TILE_SIZE, y: ROOF.y * TILE_SIZE, width: 7 * TILE_SIZE, height: 6 * TILE_SIZE };
    expect(session.area).toBe('exchange');
    expect(session.player).toEqual(arrival);
    expect(session.elevation).toBe(EXCHANGE_ROOF_HEIGHT);
    // Standing over the tower's own street footprint (the street's tiles 12-18, 5-10; D-078).
    const tile = worldToTile(arrival.x, arrival.y);
    expect(tile.x).toBeGreaterThanOrEqual(STREET_ORIGIN_X + 12);
    expect(tile.x).toBeLessThanOrEqual(STREET_ORIGIN_X + 18);
    expect(tile.y).toBeGreaterThanOrEqual(5);
    expect(tile.y).toBeLessThanOrEqual(10);
    expect(world.view.calls.map(({ method, args }) => [method, ...args])).toEqual([
      // The frame's own (idle) motion, then the ride.
      ['setPlayerMotion', IDLE_MOTION],
      ['setPlayerMotion', IDLE_MOTION],
      ['setStreetVisible', true],
      ['setDoorsVisible', true],
      ['setRemoteVisible', true],
      ['setLabelsVisible', true],
      ['showRoom', null],
      ['showRooftop', 'exchange'],
      ['setCameraBounds', roofBounds],
      ['setPlayerPosition', arrival, true],
      ['setPlayerElevation', EXCHANGE_ROOF_HEIGHT],
      ['renderRoom', 'exchange', []],
    ]);

    world.view.calls.length = 0;
    ride(world, 'degen');
    expect(session.elevation).toBe(0);
    expect(world.view.last('showRooftop')).toEqual([null]);
    expect(world.view.last('setPlayerElevation')).toEqual([0]);
    expect(world.view.last('setStreetVisible')).toEqual([false]);
    expect(world.view.last('showRoom')).toEqual(['exchange', 'degen']);
    expect(world.bus.count('building:entered')).toBe(1);
    expect(world.bus.count('building:exited')).toBe(0);
  });

  it('keeps the roof edges solid: no key, pace or frame walks anyone off the deck', () => {
    const world = createWorld();
    const session = world.start();
    const deck = {
      minX: (ROOF.x + 1) * TILE_SIZE + AVATAR_BODY_SIZE / 2,
      maxX: (ROOF.x + 6) * TILE_SIZE - AVATAR_BODY_SIZE / 2,
      minY: (ROOF.y + 1) * TILE_SIZE + AVATAR_BODY_SIZE / 2,
      maxY: (ROOF.y + 5) * TILE_SIZE - AVATAR_BODY_SIZE / 2,
    };
    let checked = 0;
    for (const start of [{ x: 1, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 4 }]) {
      for (const direction of KEYS) {
        for (const [sprinting, frame] of [[false, 16], [true, MAX_SESSION_FRAME_MS]] as const) {
          climbTo(world, 'roof');
          place(session, floorTileCentre('roof', start));
          tick(world);
          world.keyboard.sprinting = sprinting;
          world.keyboard.hold(keysFor(direction));
          for (let i = 0; i < 90 && session.level === 'roof'; i++) {
            tick(world, frame);
            if (session.level !== 'roof') break;
            // On the roof the player is always on the deck, at the roof's height.
            expect(session.player.x).toBeGreaterThanOrEqual(deck.minX - 1e-6);
            expect(session.player.x).toBeLessThanOrEqual(deck.maxX + 1e-6);
            expect(session.player.y).toBeGreaterThanOrEqual(deck.minY - 1e-6);
            expect(session.player.y).toBeLessThanOrEqual(deck.maxY + 1e-6);
            expect(session.elevation).toBe(EXCHANGE_ROOF_HEIGHT);
            checked += 1;
          }
          world.keyboard.release();
          world.keyboard.sprinting = false;
          // Only the lift leaves the roof, and it goes to the Degen floor.
          expect(['roof', 'degen']).toContain(session.level);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('never rides straight back: a key still held from the ride walks the rider away', () => {
    const world = createWorld();
    const session = world.start();
    let rides = 0;
    for (const from of ['ground', 'degen', 'roof'] as const) {
      const floor = TOWER_FLOORS[from];
      for (const lift of floor.lifts) {
        // Every free tile around the pad, stepping straight at it.
        for (let y = lift.y - 1; y <= lift.y + lift.height; y++) {
          for (let x = lift.x - 1; x <= lift.x + lift.width; x++) {
            const tile = floor.tiles[y]?.[x];
            if (tile !== 'floor') continue;
            const dx = Math.sign(Math.min(Math.max(x, lift.x), lift.x + lift.width - 1) - x);
            const dy = Math.sign(Math.min(Math.max(y, lift.y), lift.y + lift.height - 1) - y);
            climbTo(world, from);
            place(session, floorTileCentre(from, { x, y }));
            tick(world);
            const levels: (FixedRoomLevelId | null)[] = [];
            world.keyboard.hold(keysFor([dx, dy]));
            for (let i = 0; i < 150; i++) {
              tick(world);
              if (levels.at(-1) !== session.level) levels.push(session.level);
            }
            world.keyboard.release();
            // One ride at most (a diagonal can meet a wall first), never a ride back.
            expect(levels.length, `${from} (${x},${y}) -> ${lift.to}`).toBeLessThanOrEqual(2);
            if (levels.length === 2) {
              expect(levels).toEqual([from, lift.to]);
              rides += 1;
            }
          }
        }
      }
    }
    expect(rides).toBeGreaterThanOrEqual(10);
  });

  it('leaves from any floor when the Shell asks, and the door opens onto the ground floor again', () => {
    for (const level of ['degen', 'roof'] as const) {
      const world = createWorld();
      const session = world.start();
      climbTo(world, level);
      world.view.calls.length = 0;

      world.bus.shellEmit('world:exit-building', { building: 'exchange' });
      expect(session.area).toBe('street');
      expect(session.level).toBeNull();
      expect(session.elevation).toBe(0);
      expect(session.player).toEqual(streetTileCentre(returnTile('exchange')));
      expect(world.view.last('setStreetVisible')).toEqual([true]);
      expect(world.view.last('showRoom')).toEqual([null]);
      expect(world.view.count('showRooftop')).toBe(level === 'roof' ? 1 : 0);
      if (level === 'roof') {
        expect(world.view.last('showRooftop')).toEqual([null]);
        expect(world.view.last('setPlayerElevation')).toEqual([0]);
      }
      expect(world.bus.count('building:exited')).toBe(1);

      enterBuilding(world, 'exchange');
      expect(session.level).toBe('ground');
      expect(session.player).toEqual(interiorTileCentre(FIXED_ROOM_DEFINITIONS.exchange.spawn));
      expect(world.view.last('showRoom')).toEqual(['exchange']);
    }
  });

  it('does not ride while the Shell owns the keyboard, and rides again once it hands back', () => {
    const world = createWorld();
    const session = world.start();
    climbTo(world, 'degen');
    world.bus.shellEmit('world:control-owner', { building: 'exchange', owner: 'shell' });
    const up = liftTo('degen', 'roof');
    place(session, floorTileCentre('degen', up));
    tick(world);
    expect(session.level).toBe('degen');
    world.bus.shellEmit('world:control-owner', { building: 'exchange', owner: 'world' });
    // Step off and on again: the pad works as soon as the World has control.
    place(session, floorTileCentre('degen', up.arrival));
    tick(world);
    place(session, floorTileCentre('degen', up));
    tick(world);
    expect(session.level).toBe('roof');
  });

  it('opens the degen counter only when the Shell makes it available', () => {
    const world = createWorld();
    const session = world.start();
    climbTo(world, 'degen');
    const station = EXCHANGE_DEGEN_LEVEL.stations[0];
    const approach = { x: station.x, y: station.y + station.height };
    place(session, floorTileCentre('degen', approach));
    tick(world);
    expect(world.room('exchange').state.highlightedStation).toBe(EXCHANGE_DEGEN_STATION);
    expect(world.bus.count('station:activated')).toBe(0);

    world.bus.shellEmit('world:stations', {
      building: 'exchange',
      stations: [
        { station: 'exchange:swap', label: 'SWAP', status: 'locked' },
        { station: EXCHANGE_DEGEN_STATION, label: 'DEGEN', status: 'available' },
      ],
    });
    expect(world.bus.payloads('station:activated')).toEqual([]);
    tick(world);
    world.keyboard.pressE();
    expect(world.bus.payloads('station:activated')).toEqual([{ building: 'exchange', station: EXCHANGE_DEGEN_STATION }]);
    expect(world.view.last('renderRoom')![1].map(({ label, status }) => ({ label, status }))).toEqual([
      { label: 'DEGEN', status: 'available' },
    ]);
  });

  it('stays out of lobby presence on every floor and rejoins the street on the way out', () => {
    const world = createWorld();
    const session = world.start();
    enterBuilding(world, 'exchange');
    const moved = world.bus.count('player:moved');
    for (const level of ['degen', 'roof'] as const) {
      ride(world, level);
      for (const direction of KEYS) {
        world.keyboard.hold(keysFor(direction));
        for (let i = 0; i < 20; i++) tick(world);
        world.keyboard.release();
      }
      if (session.level !== level) break;
    }
    expect(world.bus.count('player:moved')).toBe(moved);
    world.bus.shellEmit('world:exit-building', { building: 'exchange' });
    tick(world);
    expect(world.bus.count('player:moved')).toBeGreaterThan(moved);
  });
});

// ---------------------------------------------------------------------------
// D-087: the roof and the Avatar Studio are shared presence areas
// ---------------------------------------------------------------------------

/** The events emitted since `from`, in order, with what `area:moved` said. */
function eventsSince(world: World, from: number): string[] {
  return world.bus.emitted.slice(from).map(({ event }) => event);
}

describe('WorldSession: shared presence areas (D-087)', () => {
  it('announces the roof when the lift reaches it, with the arrival placement first', () => {
    const world = createWorld();
    const session = world.start();
    climbTo(world, 'degen');
    const before = world.bus.emitted.length;

    ride(world, 'roof');
    expect(eventsSince(world, before)).toEqual(['area:moved', 'rooftop:entered']);
    const arrival = floorTileCentre('roof', liftTo('roof', 'degen').arrival);
    const [placement] = world.bus.payloads('area:moved');
    expect(placement?.position).toEqual(arrival);
    expect(['up', 'down', 'left', 'right']).toContain(placement?.facing);
    expect(Object.isFrozen(placement)).toBe(true);
    expect(world.bus.payloads('rooftop:entered')).toEqual([{}]);
    expect(session.level).toBe('roof');
  });

  it('publishes roof moves as area moves, never as street moves', () => {
    const world = createWorld();
    const session = world.start();
    climbTo(world, 'roof');
    const street = world.bus.count('player:moved');
    const area = world.bus.count('area:moved');
    for (let i = 0; i < 5; i++) tickHolding(world, { left: true });
    expect(world.bus.count('player:moved')).toBe(street);
    expect(world.bus.count('area:moved')).toBe(area + 5);
    const last = world.bus.payloads('area:moved').at(-1);
    expect(last).toEqual({ position: session.player, facing: 'left' });
    // Idle frames publish nothing.
    tick(world);
    expect(world.bus.count('area:moved')).toBe(area + 5);
  });

  it('announces leaving the roof by lift, and the floor below publishes nothing', () => {
    const world = createWorld();
    world.start();
    climbTo(world, 'roof');
    const before = world.bus.emitted.length;
    ride(world, 'degen');
    expect(eventsSince(world, before)).toEqual(['rooftop:exited']);
    const area = world.bus.count('area:moved');
    for (let i = 0; i < 5; i++) tickHolding(world, { right: true });
    expect(world.bus.count('area:moved')).toBe(area);
    // Back up, and down again: each ride is announced once.
    ride(world, 'roof');
    ride(world, 'degen');
    expect(world.bus.count('rooftop:entered')).toBe(2);
    expect(world.bus.count('rooftop:exited')).toBe(2);
  });

  it('leaves the roof before the street placement and the building exit when the Shell releases the player', () => {
    const world = createWorld();
    world.start();
    climbTo(world, 'roof');
    const before = world.bus.emitted.length;
    world.bus.shellEmit('world:exit-building', { building: 'exchange' });
    expect(eventsSince(world, before)).toEqual(['rooftop:exited', 'player:moved', 'building:exited']);
  });

  it('never announces a roof for any other floor or building, and publishes area moves only from the bunker and the arena', () => {
    for (const building of ROOM_BUILDINGS) {
      const world = createWorld();
      world.start();
      enterBuilding(world, building);
      for (let i = 0; i < 5; i++) tickHolding(world, { up: true });
      if (building === 'exchange') ride(world, 'degen');
      expect(world.bus.count('rooftop:entered'), building).toBe(0);
      // D-112: the bunker is a shared room, and the arena (D-114); every other interior is private.
      if (building === 'bunker' || building === 'arena') expect(world.bus.count('area:moved'), building).toBeGreaterThan(0);
      else expect(world.bus.count('area:moved'), building).toBe(0);
    }
  });

  it('places the player in the Studio before announcing it, publishes Studio moves, and leaves for the street', () => {
    const world = createWorld();
    const session = world.start();
    const before = world.bus.emitted.length;
    enterStudioByEntrance(world);
    const entered = eventsSince(world, before);
    expect(entered.slice(-2)).toEqual(['area:moved', 'avatar-studio:entered']);
    expect(world.bus.payloads('area:moved').at(-1)?.position).toEqual(STUDIO_SPAWN);
    // Peers in the Studio are drawn there: remotes stay visible.
    expect(world.view.last('setRemoteVisible')).toEqual([true]);

    const street = world.bus.count('player:moved');
    tickHolding(world, { down: true });
    expect(world.bus.payloads('area:moved').at(-1)).toEqual({ position: session.player, facing: 'down' });
    expect(world.bus.count('player:moved')).toBe(street);

    const leaving = world.bus.emitted.length;
    stepOntoStudioTile(world, STUDIO_EXIT);
    expect(session.area).toBe('street');
    // The last Studio placement, then the street's, then the exit.
    expect(eventsSince(world, leaving)).toEqual(['area:moved', 'player:moved', 'avatar-studio:exited']);
  });
});

// ---------------------------------------------------------------------------
// D-125: a building exit puts the player outside it, on the street
// ---------------------------------------------------------------------------

/** A building's whole street door rect, the arena's arch and the bunker's stairhead included. */
function streetDoor(building: BuildingId) {
  const door = STREET.doors.find((candidate) => candidate.building === building);
  if (!door) throw new Error(`No door for ${building}`);
  return door;
}

/** Is `tile` orthogonally outside `rect`, touching it? (Inside scores 0, so false.) */
function tileTouchesRect(
  tile: Point,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  const dx = Math.max(rect.x - tile.x, 0, tile.x - (rect.x + rect.width - 1));
  const dy = Math.max(rect.y - tile.y, 0, tile.y - (rect.y + rect.height - 1));
  return dx + dy === 1;
}

/** Hold `keys` for up to `frames` walking frames, or until `until` is true. */
function walkUntil(
  world: World,
  keys: Partial<MovementInput>,
  until: () => boolean,
  frames = 200,
): void {
  for (let i = 0; i < frames && !until(); i++) tickHolding(world, keys, MAX_SESSION_FRAME_MS);
}

describe('WorldSession: a building exit puts the player outside it (D-125)', () => {
  /**
   * The lead's bug, on real keys end to end: walk south down the Studio path
   * onto the hidden entrance, walk north out of the Studio's exit, and end up
   * standing on the street outside the entrance — not back at the spawn, which
   * is where this used to drop the player.
   */
  it('walks into the Studio and out again, onto the street tile outside its entrance, facing away', () => {
    const world = createWorld();
    const session = world.start();
    // Two tiles north of the entrance, on the Studio path's return column.
    place(world.session, streetTileCentre({ x: STUDIO_RETURN.x, y: STUDIO_RETURN.y - 1 }));
    walkUntil(world, { down: true }, () => session.area === 'studio');
    expect(session.area).toBe('studio');
    expect(session.player).toEqual(STUDIO_SPAWN);

    const leaving = world.bus.emitted.length;
    // North out of the exit, the two tiles above the Studio spawn.
    walkUntil(world, { up: true }, () => session.area === 'street');

    // Outside the room: on the street, on the tile just outside its entrance.
    expect(session.area).toBe('street');
    expect(worldToTile(session.player.x, session.player.y)).toEqual(STUDIO_RETURN);
    expect(session.player).toEqual(streetTileCentre(STUDIO_RETURN));
    expect(isSolidAt(STREET, STUDIO_RETURN.x, STUDIO_RETURN.y)).toBe(false);
    // Touching the entrance, and off it: outside, not still in the doorway.
    expect(STUDIO_RETURN.y).toBe(STREET.avatarStudioEntrance.y - 1);

    // Facing away from the entrance, in the view and on the wire.
    expect(AVATAR_STUDIO_RETURN_FACING).toBe('up');
    expect(session.facing).toBe('up');
    expect(world.view.last('setPlayerFacing')).toEqual(['up']);

    // D-087: presence is back in street scope — the street placement, carrying
    // the tile outside the entrance, lands before the exit is announced, and
    // no further Studio area move follows it.
    expect(eventsSince(world, leaving).slice(-2)).toEqual(['player:moved', 'avatar-studio:exited']);
    expect(world.bus.payloads('player:moved').at(-1)).toEqual({
      position: streetTileCentre(STUDIO_RETURN),
      facing: 'up',
    });
    const areaMoves = world.bus.count('area:moved');
    walkUntil(world, { up: true }, () => false, 3);
    expect(world.bus.count('area:moved')).toBe(areaMoves);
    expect(world.bus.count('player:moved')).toBeGreaterThan(0);
  });

  it('holds the Studio entrance after the exit, so a held key cannot walk the player back in', () => {
    const world = createWorld();
    const session = world.start();
    enterStudioByEntrance(world);
    stepOntoStudioTile(world, STUDIO_EXIT);
    expect(session.area).toBe('street');

    // The key that walked them out is still down, and the entrance is one tile
    // south. The hold swallows it, and it stays shut until stepped off.
    walkUntil(world, { down: true }, () => false, 40);
    expect(session.area).toBe('street');
    expect(world.bus.count('avatar-studio:entered')).toBe(1);

    // Step off the entrance and walk back on: it opens again.
    walkUntil(world, { up: true }, () => worldToTile(session.player.x, session.player.y).y < STUDIO_RETURN.y);
    walkUntil(world, { down: true }, () => session.area === 'studio');
    expect(session.area).toBe('studio');
    expect(world.bus.count('avatar-studio:entered')).toBe(2);
  });

  it('puts the player outside every other building too: Bank, Vault, Exchange, Post Office, Bridge, bunker and arena', () => {
    // Every room a World can build, the opened Vault's included.
    const definitions = fixedRoomDefinitionsFor({ vaultOpen: true });
    expect(new Set(definitions.map((definition) => definition.building))).toEqual(
      new Set(['bank', 'vault', 'exchange', 'post-office', 'bridge', 'bunker', 'arena']),
    );
    for (const definition of definitions) {
      const building = definition.building;
      const world = createWorld({ vaultOpen: true });
      const session = world.start();
      const door = streetDoor(building);
      place(session, streetTileCentre({ x: door.x, y: door.y }));
      tick(world);
      expect(session.area, building).toBe(building);

      place(session, interiorTileCentre(definition.exit));
      tick(world);
      const landed = worldToTile(session.player.x, session.player.y);
      // Outside: on the street, on a walkable tile, off the door itself (so
      // the player is never left standing in their own doorway) and touching
      // it, so the exit is where the door is and not somewhere else entirely.
      expect(session.area, building).toBe('street');
      expect(isSolidAt(STREET, landed.x, landed.y), building).toBe(false);
      expect(doorAt(STREET, landed.x, landed.y), building).toBe(null);
      expect(tileTouchesRect(landed, door), building).toBe(true);
      // The street placement carries that tile: presence goes back live on the
      // street there, not where the player entered from.
      expect(world.bus.payloads('player:moved').at(-1)?.position, building)
        .toEqual(streetTileCentre(landed));
    }
  });
});

// ---------------------------------------------------------------------------
// D-077: the Vault, D-007's locked facade until the Shell opens it
// ---------------------------------------------------------------------------

const VAULT_STATION = VAULT_ROOM_DEFINITION.stations[0];
/** The tile directly south of the Vault's SUPPLY counter: its approach. */
const VAULT_APPROACH = { x: VAULT_STATION.x, y: VAULT_STATION.y + VAULT_STATION.height };

/** From the spawn east along the road to the Vault door's column, then north into it. */
function walkToVaultDoor(world: World): void {
  const session = world.session;
  const door = doorTile('vault');
  world.keyboard.hold({ right: true });
  for (let frame = 0; frame < 60 && worldToTile(session.player.x, session.player.y).x < door.x + 1; frame += 1) {
    session.update(MAX_SESSION_FRAME_MS);
  }
  world.keyboard.hold({ up: true });
  for (
    let frame = 0;
    frame < 20 && session.area === 'street' && worldToTile(session.player.x, session.player.y).y > door.y;
    frame += 1
  ) {
    session.update(MAX_SESSION_FRAME_MS);
  }
  world.keyboard.release();
}

describe('WorldSession: the Vault (D-077)', () => {
  it('keeps the Vault a locked facade by default: its door emits building:locked and has no room', () => {
    const world = createWorld();
    const session = world.start();
    expect(internals(session).roomControllers.vault).toBeUndefined();
    walkToVaultDoor(world);
    expect(worldToTile(session.player.x, session.player.y)).toMatchObject({ y: doorTile('vault').y });
    expect(session.area).toBe('street');
    expect(world.bus.payloads('building:locked')).toEqual([{ building: 'vault', reason: 'coming-soon' }]);
    expect(world.bus.count('building:entered')).toBe(0);
    expect(world.view.argsOf('showRoom').every(([building]) => building === null)).toBe(true);
  });

  it('walks in through the Vault door once the Shell opens it, and never reads it as locked', () => {
    const world = createWorld({ vaultOpen: true });
    const session = world.start();
    walkToVaultDoor(world);
    expect(session.area).toBe('vault');
    expect(session.level).toBe('ground');
    expect(world.bus.payloads('building:entered')).toEqual([{ building: 'vault' }]);
    expect(world.bus.count('building:locked')).toBe(0);
    expect(world.view.last('showRoom')).toEqual(['vault']);
    expect(world.view.last('setCameraBounds')).toEqual([INTERIOR_BOUNDS]);
    expect(world.view.last('setPlayerPosition')).toEqual([interiorTileCentre(VAULT_ROOM_DEFINITION.spawn), true]);
  });

  it('activates the SUPPLY counter the Shell makes available, and leaves by the exit onto the street', () => {
    const world = createWorld({ vaultOpen: true });
    const session = world.start();
    place(session, streetTileCentre(doorTile('vault')));
    tick(world);
    expect(session.area).toBe('vault');
    // Every visit begins locked, until the Shell's snapshot says otherwise.
    expect(world.view.last('renderRoom')).toEqual([
      'vault',
      VAULT_ROOM_DEFINITION.stations.map((station) => ({ ...station, status: 'locked', highlighted: false, notice: false })),
    ]);

    world.bus.shellEmit('world:stations', {
      building: 'vault',
      stations: [{ station: VAULT_SUPPLY_STATION, label: 'SUPPLY', status: 'available' }],
    });
    expect(world.bus.payloads('station:activated')).toEqual([]);
    place(session, interiorTileCentre(VAULT_APPROACH));
    tick(world);
    expect(world.bus.payloads('station:activated')).toEqual([]);
    world.keyboard.pressE();
    expect(world.bus.payloads('station:activated')).toEqual([{ building: 'vault', station: VAULT_SUPPLY_STATION }]);
    expect(world.view.last('renderRoom')).toEqual([
      'vault',
      [
        { ...VAULT_STATION, label: 'SUPPLY', status: 'available', highlighted: true, notice: false },
        // The other three counters are untouched by SUPPLY's snapshot: still locked.
        ...VAULT_ROOM_DEFINITION.stations.slice(1).map((station) => ({ ...station, status: 'locked', highlighted: false, notice: false })),
      ],
    ]);

    place(session, interiorTileCentre(VAULT_ROOM_DEFINITION.exit));
    tick(world);
    expect(session.area).toBe('street');
    expect(world.bus.payloads('building:exited')).toEqual([{ building: 'vault' }]);
    expect(world.view.last('showRoom')).toEqual([null]);
    expect(world.view.last('setPlayerPosition')).toEqual([streetTileCentre(returnTile('vault')), true]);
    expect(world.view.last('setCameraBounds')).toEqual([STREET_BOUNDS]);
  });
});

// ---------------------------------------------------------------------------
// D-117: press E to interact
// ---------------------------------------------------------------------------

interface StationCase {
  readonly building: RoomBuilding | 'vault';
  readonly level: FixedRoomLevelId;
  readonly station: FixedRoomStationDefinition;
}

/** Every counter on every floor of every room, the opened Vault's (and its Vesu counters) included. */
const STATION_CASES: readonly StationCase[] = fixedRoomDefinitionsFor({ vaultOpen: true }).flatMap((definition) => [
  ...definition.stations.map((station) => ({ building: definition.building as StationCase['building'], level: 'ground' as const, station })),
  ...(FIXED_ROOM_LEVELS[definition.building] ?? []).flatMap((level) =>
    level.stations.map((station) => ({ building: definition.building as StationCase['building'], level: level.level, station }))),
]);

/** A walkable tile in a station's approach ring: where a player stands to use it. */
function standingTile(level: FixedRoomLevelMap, station: FixedRoomStationDefinition): Point {
  for (let y = station.y - 1; y <= station.y + station.height; y++) {
    for (let x = station.x - 1; x <= station.x + station.width; x++) {
      const inside = x >= station.x && x < station.x + station.width && y >= station.y && y < station.y + station.height;
      if (inside || isFixedRoomSolidAt(level, x, y) || isFixedRoomExit(level, x, y) || fixedRoomLiftAt(level, x, y)) continue;
      return { x, y };
    }
  }
  throw new Error(`No standing tile for ${station.station}`);
}

function floorOf(building: StationCase['building'], level: FixedRoomLevelId): FixedRoomLevelMap {
  const definition = fixedRoomDefinitionsFor({ vaultOpen: true }).find((candidate) => candidate.building === building)!;
  if (level === 'ground') return createFixedRoom(definition);
  return createFixedRoomLevel(FIXED_ROOM_LEVELS[building]!.find((candidate) => candidate.level === level)!);
}

function openEveryCounter(world: World, building: StationCase['building']): void {
  const stations = STATION_CASES.filter((entry) => entry.building === building).map(({ station }) => ({
    station: station.station,
    label: station.label,
    status: 'available' as const,
  }));
  world.bus.shellEmit('world:stations', { building, stations });
}

function enterFloor(world: World, building: StationCase['building'], level: FixedRoomLevelId): void {
  place(world.session, streetTileCentre(doorTile(building)));
  tick(world);
  expect(world.session.area).toBe(building);
  if (level !== 'ground') climbTo(world, level);
}

function target(id: string, rect: { x: number; y: number; width: number; height: number }, used: string[]): InteractionTarget {
  return { id, label: id.toUpperCase(), rect, activate: () => used.push(id) };
}

describe('WorldSession: press E to interact (D-117)', () => {
  it.each(STATION_CASES.map((entry) => [`${entry.building} ${entry.level} ${entry.station.station}`, entry] as const))(
    'never opens %s by walking up to it: it prompts, and E opens it',
    (_name, { building, level, station }) => {
      const world = createWorld({ vaultOpen: true });
      world.start();
      enterFloor(world, building, level);
      openEveryCounter(world, building);
      const floor = floorOf(building, level);
      const opened = (): number => world.bus.count('station:activated');

      place(world.session, floorTileCentre(level, standingTile(floor, station)));
      tick(world);
      // Proximity alone: highlighted and prompted, never opened.
      expect(world.room(building as RoomBuilding).state.highlightedStation).toBe(station.station);
      expect(opened()).toBe(0);
      // A reserved station prompts with its own short line (the bunker's lift, D-107; the arena's box, D-114).
      const label = station.reserved ? station.prompt ?? BUNKER_ELEVATOR_PROMPT : station.label.replace(/\s+/g, ' ');
      expect(world.session.interactionPrompt).toMatchObject({ id: station.station, label });
      expect(world.view.last('setInteractionPrompt')).toEqual([world.session.interactionPrompt]);
      tick(world);
      expect(opened()).toBe(0);

      world.keyboard.pressE();
      if (station.reserved) {
        // The bunker's lift or the arena's box: its notice in the prompt's place, and nothing opens.
        expect(opened()).toBe(0);
        expect(world.room(building as RoomBuilding).state.noticeStation).toBe(station.station);
        tick(world);
        expect(world.session.interactionPrompt).toBeNull();
      } else {
        expect(world.bus.payloads('station:activated')).toEqual([{ building, station: station.station }]);
      }

      // Walking away takes the prompt down.
      place(world.session, floorTileCentre(level, floor.spawn));
      tick(world);
      expect(world.session.interactionPrompt).toBeNull();
      expect(world.view.last('setInteractionPrompt')).toEqual([null]);
      world.keyboard.pressE();
      expect(opened()).toBe(station.reserved ? 0 : 1);
    },
  );

  it('never changes clothes at a Studio figure by walking onto it: it prompts, and E puts it on', () => {
    const world = createWorld();
    world.start();
    enterStudioByEntrance(world);
    stepOntoStudioTile(world, { x: 9, y: 6 });
    expect(world.selected()).toBe('avatar-1');
    expect(world.session.interactionPrompt).toMatchObject({ id: 'studio:figure-7', label: 'WEAR' });
    world.keyboard.pressE();
    expect(world.selected()).toBe('avatar-7');
    // Worn now: no prompt.
    tick(world);
    expect(world.session.interactionPrompt).toBeNull();
    stepOntoStudioTile(world, { x: 6, y: 5 });
    expect(world.studio().state.highlightedFigure).toBeNull();
  });

  it('never opens a plaza station by walking up to it: E does', () => {
    const world = createWorld();
    world.start();
    place(world.session, streetTileCentre({ x: STREET_ORIGIN_X + 5, y: 25 }));
    tickHolding(world, { up: true });
    tick(world);
    expect(world.session.interactionPrompt).toMatchObject({ id: PLAZA_MONUMENT_STATION, label: 'POOL STATS' });
    expect(world.bus.count('station:activated')).toBe(0);
    world.keyboard.pressE();
    expect(world.bus.payloads('station:activated')).toEqual([{ building: 'plaza', station: PLAZA_MONUMENT_STATION }]);
  });

  it('reads no E aimed at a text field, no held repeat, and nothing while a panel holds the keyboard', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    makeBankStationAvailable(world);
    place(world.session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    expect(world.session.interactionPrompt).not.toBeNull();

    world.keyboard.pressE({ repeat: false, target: { tagName: 'INPUT' } });
    world.keyboard.pressE({ repeat: false, target: { tagName: 'textarea' } });
    world.keyboard.pressE({ repeat: false, target: { isContentEditable: true } });
    world.keyboard.pressE({ repeat: true, target: null });
    expect(world.bus.count('station:activated')).toBe(0);

    // A panel (or Menu Mode) claims the keyboard: no prompt, and neither E nor the touch button acts.
    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    tick(world);
    expect(world.session.interactionPrompt).toBeNull();
    expect(world.session.interact()).toBe(false);
    expect(world.bus.count('station:activated')).toBe(0);

    world.bus.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    tick(world);
    expect(world.session.interactionPrompt).not.toBeNull();
    expect(world.session.interact()).toBe(true);
    expect(world.bus.count('station:activated')).toBe(1);
  });

  it('uses the nearest of two stations in reach, or the one the player faces', () => {
    const world = createWorld();
    const session = world.start();
    const used: string[] = [];
    const here = streetTileCentre({ x: STREET.spawn.x, y: STREET.spawn.y });
    place(session, here);
    // Two stations the player stands between: one a tile to the west, one two tiles east.
    session.interactions.register({
      targets: () => [
        target('gate', { x: here.x + 2 * TILE_SIZE, y: here.y - 16, width: 32, height: 32 }, used),
        target('board', { x: here.x - TILE_SIZE - 16, y: here.y - 16, width: 32, height: 32 }, used),
      ],
    });
    tick(world);
    expect(session.interactionPrompt?.id).toBe('board');
    world.keyboard.pressE();
    expect(used).toEqual(['board']);
    // Facing the farther one: it wins over the nearer one beside or behind.
    place(session, here);
    tickHolding(world, { right: true });
    place(session, here);
    tick(world);
    expect(session.interactionPrompt?.id).toBe('gate');
    world.keyboard.pressE();
    expect(used).toEqual(['board', 'gate']);
  });

  it('hands a target\'s 3D object to the view with its prompt, for its edge glow (D-123)', () => {
    const world = createWorld();
    const session = world.start();
    const used: string[] = [];
    const here = streetTileCentre({ x: STREET.spawn.x, y: STREET.spawn.y });
    place(session, here);
    const mesh = { isObject3D: true, name: 'ring-gate' };
    session.interactions.register({
      targets: () => [{ ...target('gate', { x: here.x - 16, y: here.y - 48, width: 32, height: 32 }, used), object: mesh }],
    });
    tick(world);
    expect(session.interactionPrompt).toMatchObject({ id: 'gate', label: 'GATE' });
    expect(session.interactionPrompt?.object).toBe(mesh);
    expect(world.view.last('setInteractionPrompt')).toEqual([session.interactionPrompt]);
    // A fight suspends it: no prompt, so no glow and no chip.
    const release = session.interactions.suspend('combat');
    tick(world);
    expect(world.view.last('setInteractionPrompt')).toEqual([null]);
    release();
    tick(world);
    expect(session.interactionPrompt?.object).toBe(mesh);
  });

  it('yields E to a combat context: stations first, and none at all while a fight suspends them', () => {
    const world = createWorld();
    const session = world.start();
    const attacks: number[] = [];
    session.interactions.addAction({ id: 'arena:attack', priority: 10, run: () => attacks.push(1) > 0 });
    enterBuilding(world, 'bank');
    makeBankStationAvailable(world);
    // Away from every station, E is the action's.
    world.keyboard.pressE();
    expect(attacks).toHaveLength(1);
    // At a station, E is interact.
    place(session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    world.keyboard.pressE();
    expect(world.bus.count('station:activated')).toBe(1);
    expect(attacks).toHaveLength(1);
    // A fight holds the stations off: no prompt, and E attacks even here.
    const release = session.interactions.suspend('combat');
    expect(session.interactions.suspended).toBe(true);
    tick(world);
    expect(session.interactionPrompt).toBeNull();
    world.keyboard.pressE();
    expect(attacks).toHaveLength(2);
    expect(world.bus.count('station:activated')).toBe(1);
    release();
    tick(world);
    expect(session.interactionPrompt?.id).toBe(BANK_STATION.station);
  });

  it.each(ROOM_BUILDINGS.map((building) => [building] as const))(
    'still walks in through the %s door without E: doors and the bunker stair are transitions',
    (building) => {
      const world = createWorld();
      world.start();
      place(world.session, streetTileCentre(doorTile(building)));
      tick(world);
      expect(world.session.area).toBe(building);
      expect(world.bus.payloads('building:entered')).toEqual([{ building }]);
      expect(world.keyboard.interactListenerCount()).toBe(1);
    },
  );

  it('still walks into the Avatar Studio without E', () => {
    const world = createWorld();
    world.start();
    enterStudioByEntrance(world);
    expect(world.bus.count('avatar-studio:entered')).toBe(1);
  });
});
