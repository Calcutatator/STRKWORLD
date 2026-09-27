import { describe, expect, it, vi } from 'vitest';
import type { AvatarSpriteKey, BuildingId, ShellEvents, WorldEvents } from '@strkworld/shared';
import { pairedAvatarSprite } from './avatar-state.js';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_TILE_SIZE,
  avatarStudioSpawnToWorld,
  type AvatarStudioController,
} from './avatar-studio.js';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';
import {
  FIXED_ROOM_DEFINITIONS,
  FIXED_ROOM_TILE_SIZE,
  type FixedRoomController,
} from './fixed-room.js';
import type { InputGate } from './input-gate.js';
import { createStreetMap, isSolidAt, TILE_SIZE, tileToWorld, worldToTile } from './map/street.js';
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

  // The sandbox key (D-060) is covered by world-session-sandbox.test.ts; this
  // suite never supplies a sandbox, so only the outfit key is tracked here.
  on(event: 'keydown-F' | 'keydown-E', handler: OutfitHandler): this {
    if (event !== 'keydown-F') return this;
    this.journal.push(`keyboard.on:${event}`);
    this.handlers.add(handler);
    return this;
  }

  off(event: 'keydown-F' | 'keydown-E', handler: OutfitHandler): this {
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
    setStreetVisible: (visible) => record('setStreetVisible', [visible]),
    setDoorsVisible: (visible) => record('setDoorsVisible', [visible]),
    setLabelsVisible: (visible) => record('setLabelsVisible', [visible]),
    setRemoteVisible: (visible) => record('setRemoteVisible', [visible]),
    showRoom: (building) => record('showRoom', [building]),
    renderRoom: (building, stations) => record('renderRoom', [building, stations]),
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
    setCarried: (colour) => record('setCarried', [colour]),
    setSandboxAim: (aim) => record('setSandboxAim', [aim]),
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
function createWorld(options: { readonly keyboard?: boolean; readonly config?: boolean } = {}) {
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

function enterBuilding(world: World, building: RoomBuilding): void {
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
  it('retries the same Avatar Studio tile after selection delivery fails', () => {
    const world = createWorld();
    world.start();
    enterStudioByEntrance(world);

    const error = new Error('selection delivery failed');
    world.bus.failNext('avatar:selected', error);
    // Figure 2 stands on Studio tile (5, 3).
    place(world.session, studioTileCentre({ x: 5, y: 3 }));
    const sentinel = { ...internals(world.session).lastTile };

    expect(() => tickHolding(world, { down: true })).toThrow(error);
    expect(internals(world.session).lastTile).toEqual(sentinel);
    expect(world.selected()).toBe('avatar-1');

    expect(() => tickHolding(world, { down: true })).not.toThrow();
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

    // Walking onto a figure still selects it, and F pairs that figure.
    stepOntoStudioTile(world, { x: 14, y: 6 });
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
    // is on the wire too; nothing else is.
    world.expectOnlySelectionOnTheWire(['building:entered', 'building:exited', 'player:moved']);
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

  it('retries room tile delivery after a failed station handoff', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    makeBankStationAvailable(world);
    world.bus.failNext('station:activated', new Error('room tile handoff failed'));
    place(world.session, interiorTileCentre(BANK_APPROACH));

    expect(() => tick(world)).toThrow('room tile handoff failed');
    // The failed activation handed the keyboard back rather than stranding it.
    expect(world.session.inputSuspended).toBe(false);

    expect(() => tick(world)).not.toThrow();
    expect(world.bus.count('station:activated')).toBe(2);
    // Committed now: standing on the approach does not re-deliver the tile.
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
    expect(world.bus.shellListenerCount()).toBe(12);

    stale.destroy();
    const replacement = world.start();

    expect(world.cycles).toHaveLength(2);
    expect(world.keyboard.listenerCount()).toBe(1);
    expect(staleBank.state.inRoom).toBe(false);
    expect(world.bus.shellListenerCount()).toBe(12);

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
    expect(countEntries(world.journal, 'shell.off:')).toBe(12);
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

  it('does not roll back a room tile after station delivery retires the session', () => {
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

    expect(() => tick(world)).toThrow(error);
    expect(internals(session).lastTile).toEqual(BANK_APPROACH);
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
    expect(world.selected()).toBe('avatar-3');
    expect(world.studio().state.highlightedFigure).toBe(3);
    expect(world.view.last('syncStudio')).toEqual([{ visible: true, highlightedFigure: 3 }]);

    // An unchanged tile is not reported again: a re-report would reselect
    // figure 3 over the toggled outfit.
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

  it('activates the Bank counter when it becomes available under a player already at it', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    place(world.session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    expect(world.bus.payloads('station:activated')).toEqual([]);
    // Standing still, no tile change: the snapshot alone brings it up.
    makeBankStationAvailable(world);
    expect(world.bus.payloads('station:activated')).toEqual([{ building: 'bank', station: BANK_STATION.station }]);
    tick(world);
    expect(world.bus.payloads('station:activated')).toHaveLength(1);
  });

  it('hands the active room station presentations to the view', () => {
    const world = createWorld();
    world.start();
    enterBuilding(world, 'bank');
    // The Bank's Endur staking counter rides along, locked: the Shell has not
    // switched it on (D-063).
    const staking = { ...FIXED_ROOM_DEFINITIONS.bank.stations[1], status: 'locked', highlighted: false };
    expect(world.view.last('renderRoom')).toEqual([
      'bank',
      [{ ...BANK_STATION, status: 'locked', highlighted: false }, staking],
    ]);

    makeBankStationAvailable(world);
    expect(world.view.last('renderRoom')).toEqual([
      'bank',
      [{ ...BANK_STATION, label: 'SHIELD', status: 'available', highlighted: false }, staking],
    ]);

    place(world.session, interiorTileCentre(BANK_APPROACH));
    tick(world);
    expect(world.view.last('renderRoom')).toEqual([
      'bank',
      [{ ...BANK_STATION, label: 'SHIELD', status: 'available', highlighted: true }, staking],
    ]);
    expect(world.bus.payloads('station:activated')).toEqual([
      { building: 'bank', station: BANK_STATION.station },
    ]);

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
      { position: spawn, snap: true },
    ]);
  });
});
