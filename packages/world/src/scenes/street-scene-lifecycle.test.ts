import { describe, expect, it, vi } from 'vitest';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { pairedAvatarSprite } from '../avatar-state.js';
import type { AvatarStudioController } from '../avatar-studio.js';
import { FIXED_ROOM_DEFINITIONS, type FixedRoomController } from '../fixed-room.js';
import { createInputGate, type InputGate } from '../input-gate.js';
import { createStreetMap } from '../map/street.js';
import { createStreetScene } from './street-scene.js';

vi.mock('../kenney-urban.js', () => ({
  createKenneyRuntimeTextures: vi.fn(),
  KENNEY_ATLAS_KEY: 'kenney-atlas',
  KENNEY_ATLAS_URL: '/kenney-atlas.png',
  KENNEY_DOOR_TEXTURE_KEY: 'kenney-door',
  KENNEY_TILE_TEXTURE_KEY: 'kenney-tiles',
}));

class FakeEvents {
  private readonly listeners = new Map<string, Array<{ callback: () => void; context?: unknown }>>();

  once(event: string, callback: () => void, context?: unknown): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push({ callback, context });
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const { callback, context } of listeners) callback.call(context);
  }

  count(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

function destroyable() {
  return { destroy: vi.fn() };
}

function outfitToggleBinding() {
  return { destroy: vi.fn() };
}

function cycleResources() {
  const unsubscribe = vi.fn();
  return {
    avatarVisual: { cycle: Symbol('avatar-visual') },
    unsubscribe,
    controller: { destroy: vi.fn(() => unsubscribe()) },
    studio: { state: { inRoom: true }, ...destroyable() },
    studioPresentation: { enter: vi.fn(), exit: vi.fn(), destroy: vi.fn() },
    outfitToggle: outfitToggleBinding(),
    roomGraphics: destroyable(),
    stationGraphics: destroyable(),
    studioGraphics: destroyable(),
    studioFigureLayer: destroyable(),
    roomLabel: destroyable(),
    exteriorLabel: destroyable(),
    overlay: destroyable(),
    ground: destroyable(),
    input: { resume: vi.fn() },
  };
}

class FakeScene {
  readonly events = new FakeEvents();
  readonly remoteLayers: ReturnType<typeof destroyable>[] = [];
  readonly anims = {
    exists: vi.fn(() => true),
    create: vi.fn(),
  };
  readonly add = {
    layer: vi.fn(() => {
      const layer = {
        ...destroyable(),
        setDepth: vi.fn(function setDepth(this: typeof layer) { return this; }),
        setVisible: vi.fn(function setVisible(this: typeof layer) { return this; }),
      };
      this.remoteLayers.push(layer);
      return layer;
    }),
  };
  readonly make = {
    graphics: vi.fn(() => ({
      fillStyle: vi.fn(),
      fillRoundedRect: vi.fn(),
      fillRect: vi.fn(),
      generateTexture: vi.fn(),
      destroy: vi.fn(),
    })),
  };

  constructor(_config: unknown) {}
}

interface StreetSceneHarness extends FakeScene {
  create(): void;
  cleanShutdown(): void;
  drawGround(): void;
  createDoorOverlays(): void;
  createPlayer(): void;
  createInput(): void;
  createAvatarOutfit(): void;
  createFixedRooms(): void;
  createAvatarStudio(): void;
  enterAvatarStudioRoom(): void;
  exitAvatarStudioRoom(): void;
  createCamera(): void;
  createDoorTriggers(): void;
  createRoomVisuals(): void;
  createExteriorLabels(): void;
  roomControllers: Record<string, { destroy(): void }>;
  avatarStudio: { readonly state: { readonly inRoom: boolean }; destroy(): void };
  avatarStudioPresentation: { enter(): void; exit(): void; destroy(): void };
  avatarOutfitToggle?: { destroy(): void };
  inputGate: { resume(): void };
  roomGraphics: { destroy(): void };
  roomStationGraphics: { destroy(): void };
  avatarStudioGraphics: { destroy(): void };
  avatarStudioFigureLayer?: { destroy(): void };
  roomLabels: Map<string, { destroy(): void }>;
  exteriorLabels: Map<string, { destroy(): void }>;
  doorOverlays: Array<{ destroy(): void }>;
  ground?: { destroy(): void };
  avatarVisual?: { cycle: symbol };
  lastTile: { x: number; y: number };
}

function createHarness() {
  const SceneType = createStreetScene({ Phaser: { Scene: FakeScene } as never });
  const scene = new SceneType() as unknown as StreetSceneHarness;
  let current = cycleResources();
  let failure: 'early' | 'partial' | null = null;

  scene.drawGround = vi.fn(() => {
    if (failure === 'early') throw new Error('early create failure');
    scene.ground = current.ground;
  });
  scene.createPlayer = vi.fn(() => { scene.avatarVisual = current.avatarVisual; });
  scene.createCamera = vi.fn();
  scene.createDoorTriggers = vi.fn();
  scene.createDoorOverlays = vi.fn(() => { scene.doorOverlays = [current.overlay]; });
  scene.createInput = vi.fn(() => { scene.inputGate = current.input; });
  scene.createAvatarOutfit = vi.fn(() => { scene.avatarOutfitToggle = current.outfitToggle; });
  scene.createFixedRooms = vi.fn(() => { scene.roomControllers = { bank: current.controller }; });
  scene.createAvatarStudio = vi.fn(() => {
    if (failure === 'partial') throw new Error('partial create failure');
    scene.avatarStudio = current.studio;
    scene.avatarStudioPresentation = current.studioPresentation;
  });
  scene.createRoomVisuals = vi.fn(() => {
    scene.roomGraphics = current.roomGraphics;
    scene.roomStationGraphics = current.stationGraphics;
    scene.avatarStudioGraphics = current.studioGraphics;
    scene.avatarStudioFigureLayer = current.studioFigureLayer;
    scene.roomLabels.set('bank:shielding', current.roomLabel);
  });
  scene.createExteriorLabels = vi.fn(() => {
    scene.exteriorLabels.set('bank', current.exteriorLabel);
  });

  return {
    scene,
    get current() {
      return current;
    },
    nextCycle() {
      current = cycleResources();
      return current;
    },
    failAt(next: typeof failure) {
      failure = next;
    },
    create() {
      scene.create();
    },
    shutdown() {
      scene.events.emit('shutdown');
    },
  };
}

function expectCompleteCleanup(cycle: ReturnType<typeof cycleResources>): void {
  expect(cycle.controller.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.unsubscribe).toHaveBeenCalledTimes(1);
  expect(cycle.studio.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.outfitToggle.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.roomGraphics.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.stationGraphics.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.studioGraphics.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.studioFigureLayer.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.roomLabel.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.exteriorLabel.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.overlay.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.input.resume).toHaveBeenCalledTimes(1);
}

describe('StreetScene lifecycle', () => {
  it('toggles the outfit outdoors, in the Studio and back, from one Scene-owned binding', () => {
    const harness = createWorldOutfitHarness();

    // D-053: the binding exists from create, not only while a room is active.
    expect(harness.keyboard.listenerCount()).toBe(1);
    expect(harness.selected()).toBe('avatar-1');

    harness.press();
    expect(harness.selected()).toBe('avatar-9');
    harness.press();
    expect(harness.selected()).toBe('avatar-1');
    harness.press();
    expect(harness.selected()).toBe('avatar-9');

    // The Studio reads the same selection rather than owning a second one, so
    // an outdoor toggle is still the current state on entry.
    harness.scene.avatarStudio.enter();
    expect(harness.keyboard.listenerCount()).toBe(1);
    expect(harness.scene.avatarStudio.state.selected).toBe('avatar-9');
    harness.press();
    expect(harness.selected()).toBe('avatar-1');

    // Walking onto a figure still selects it, and F pairs that figure.
    harness.scene.avatarStudio.update({ x: 14, y: 6 });
    expect(harness.selected()).toBe('avatar-8');
    harness.press();
    expect(harness.selected()).toBe('avatar-16');

    // Leaving the Studio does not take the binding with it.
    harness.scene.avatarStudio.update({ x: 8, y: 0 });
    expect(harness.scene.avatarStudio.state.inRoom).toBe(false);
    expect(harness.keyboard.listenerCount()).toBe(1);
    harness.press();
    expect(harness.selected()).toBe('avatar-8');

    harness.expectOnlySelectionOnTheWire(['avatar-studio:entered', 'avatar-studio:exited']);
  });

  it('keeps toggling inside every fixed-room interior', () => {
    const harness = createWorldOutfitHarness();
    const buildings = Object.values(FIXED_ROOM_DEFINITIONS).map(
      (definition) => definition.building,
    );
    expect(buildings.length).toBeGreaterThan(0);

    for (const building of buildings) {
      const room = harness.room(building);
      room.enter();
      expect(room.state.inRoom).toBe(true);

      const inside = harness.selected();
      harness.press();
      expect(harness.selected()).toBe(pairedAvatarSprite(inside));
      harness.press();
      expect(harness.selected()).toBe(inside);
      // One Scene-owned binding; no building added its own.
      expect(harness.keyboard.listenerCount()).toBe(1);

      const exit = FIXED_ROOM_DEFINITIONS[building].exit;
      room.update({ x: exit.x, y: exit.y });
      expect(room.state.inRoom).toBe(false);
      harness.press();
      expect(harness.selected()).toBe(pairedAvatarSprite(inside));
      harness.press();
      expect(harness.selected()).toBe(inside);
    }

    harness.expectOnlySelectionOnTheWire(['building:exited']);
  });

  it('is inactive while World gameplay input is suspended', () => {
    const harness = createWorldOutfitHarness();

    // Menu mode: the Shell claims control and the gate hands over the keyboard.
    const room = harness.room('bank');
    room.enter();
    const held = harness.selected();
    harness.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    expect(harness.scene.inputGate.suspended).toBe(true);
    harness.press();
    expect(harness.selected()).toBe(held);
    // The listener is still the Scene's; it simply refuses to act.
    expect(harness.keyboard.listenerCount()).toBe(1);

    harness.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    expect(harness.scene.inputGate.suspended).toBe(false);
    harness.press();
    expect(harness.selected()).toBe(pairedAvatarSprite(held));

    // The same rule holds outdoors, whatever suspended the gate.
    room.update({ x: 8, y: 11 });
    harness.scene.inputGate.suspend();
    const outdoors = harness.selected();
    harness.press();
    expect(harness.selected()).toBe(outdoors);
    harness.scene.inputGate.resume();
    harness.press();
    expect(harness.selected()).toBe(pairedAvatarSprite(outdoors));
  });

  it('ignores held repeats and keystrokes aimed at an editable target', () => {
    const harness = createWorldOutfitHarness();

    harness.keyboard.press({ repeat: true, target: null });
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { isContentEditable: true },
      { tagName: 'SPAN', closest: () => ({}) },
    ]) {
      harness.keyboard.press({ repeat: false, target });
    }
    expect(harness.selected()).toBe('avatar-1');
    expect(harness.emitted()).toHaveLength(0);

    harness.press();
    expect(harness.selected()).toBe('avatar-9');
  });

  it('stops toggling after shutdown and rebinds exactly once per restart', () => {
    const harness = createWorldOutfitHarness();
    harness.press();
    expect(harness.selected()).toBe('avatar-9');

    const stale = harness.keyboard.snapshot();
    harness.scene.cleanShutdown();
    harness.scene.cleanShutdown();
    expect(harness.keyboard.listenerCount()).toBe(0);

    harness.press();
    stale({ repeat: false, target: null });
    expect(harness.applied()).toEqual(['avatar-9']);

    // A same-instance restart replaces the binding; it never adds a second.
    // The restarted Scene starts from the default sprite, as createPlayer does.
    harness.rebind();
    harness.rebind();
    expect(harness.keyboard.listenerCount()).toBe(1);
    harness.press();
    expect(harness.applied()).toEqual(['avatar-9', 'avatar-9']);
  });

  it('cleans every same-instance restart once while repeated shutdown stays idempotent', () => {
    const harness = createHarness();
    const cycles = [harness.current];

    harness.create();
    expect(harness.scene.avatarVisual).toBe(cycles[0]?.avatarVisual);
    expect(harness.scene.events.count('shutdown')).toBe(2);
    harness.shutdown();
    expect(harness.scene.avatarVisual).toBeUndefined();
    harness.scene.cleanShutdown();

    cycles.push(harness.nextCycle());
    harness.create();
    expect(harness.scene.avatarVisual).toBe(cycles[1]?.avatarVisual);
    expect(harness.scene.events.count('shutdown')).toBe(2);
    harness.shutdown();
    expect(harness.scene.avatarVisual).toBeUndefined();
    harness.scene.cleanShutdown();

    expect(cycles).toHaveLength(2);
    for (const cycle of cycles) expectCompleteCleanup(cycle);
    expect(harness.scene.remoteLayers).toHaveLength(2);
    expect(harness.scene.remoteLayers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.scene.remoteLayers[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.scene.events.count('shutdown')).toBe(0);
  });

  it('does not expose cleaned prior-cycle resources to an early restart failure', () => {
    const harness = createHarness();
    const completed = harness.current;
    harness.create();
    harness.shutdown();
    expectCompleteCleanup(completed);
    expect(harness.scene.events.count('shutdown')).toBe(0);

    harness.nextCycle();
    harness.failAt('early');
    expect(() => harness.create()).toThrow('early create failure');
    expect(harness.scene.events.count('shutdown')).toBe(1);
    harness.shutdown();
    harness.scene.cleanShutdown();

    expectCompleteCleanup(completed);
    expect(harness.scene.remoteLayers).toHaveLength(1);
    expect(harness.scene.events.count('shutdown')).toBe(0);

    const recovered = harness.nextCycle();
    harness.failAt(null);
    harness.create();
    harness.shutdown();
    expectCompleteCleanup(recovered);
  });

  it('cleans partial restart resources when a later create step throws', () => {
    const harness = createHarness();
    const completed = harness.current;
    harness.create();
    harness.shutdown();
    expectCompleteCleanup(completed);

    const partial = harness.nextCycle();
    harness.failAt('partial');
    expect(() => harness.create()).toThrow('partial create failure');
    expect(harness.scene.events.count('shutdown')).toBe(2);
    harness.shutdown();
    harness.scene.cleanShutdown();

    expectCompleteCleanup(completed);
    expect(partial.controller.destroy).toHaveBeenCalledTimes(1);
    expect(partial.unsubscribe).toHaveBeenCalledTimes(1);
    expect(partial.input.resume).toHaveBeenCalledTimes(1);
    expect(partial.overlay.destroy).toHaveBeenCalledTimes(1);
    expect(partial.outfitToggle.destroy).toHaveBeenCalledTimes(1);
    expect(partial.studio.destroy).not.toHaveBeenCalled();
    expect(harness.scene.remoteLayers).toHaveLength(2);
    expect(harness.scene.remoteLayers[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.scene.events.count('shutdown')).toBe(0);

    const recovered = harness.nextCycle();
    harness.failAt(null);
    harness.create();
    harness.shutdown();
    expectCompleteCleanup(recovered);
  });

  it('does not reuse a destroyed ground layer or stale tile on restart', () => {
    const harness = createHarness();
    harness.create();
    harness.shutdown();
    (harness.scene as unknown as { lastTile: { x: number; y: number } }).lastTile = { x: 7, y: 9 };

    const recovered = harness.nextCycle();
    const observedGround: unknown[] = [];
    harness.scene.drawGround = vi.fn();
    harness.scene.createPlayer = vi.fn(() => observedGround.push(harness.scene.ground));
    harness.failAt(null);
    harness.create();

    expect(observedGround).toEqual([undefined]);
    expect(harness.scene.lastTile).toEqual({ x: -1, y: -1 });
    harness.shutdown();
    expectCompleteCleanup(recovered);
  });
});

function createWorldOutfitHarness() {
  const SceneType = createStreetScene({ Phaser: { Scene: FakeScene } as never });
  const keyboard = new LifecycleKeyboard();
  const map = createStreetMap();
  const applied: AvatarSpriteKey[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const shellListeners = new Map<string, Set<(payload: unknown) => void>>();
  const bus = {
    out: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }) },
    in: {
      on(event: string, handler: (payload: unknown) => void) {
        const handlers = shellListeners.get(event) ?? new Set();
        handlers.add(handler);
        shellListeners.set(event, handlers);
        return () => handlers.delete(handler);
      },
    },
  };
  const player = {
    x: 0,
    y: 0,
    body: { setEnable: vi.fn() },
    setVelocity: vi.fn(),
    setPosition: vi.fn((x: number, y: number) => {
      player.x = x;
      player.y = y;
    }),
  };
  const scene = new SceneType() as unknown as FakeScene & {
    map: ReturnType<typeof createStreetMap>;
    player: typeof player;
    input: { keyboard: LifecycleKeyboard };
    game: { registry: { get(key: string): unknown } };
    physics: { world: { setBounds: ReturnType<typeof vi.fn> } };
    cameras: { main: { setBounds: ReturnType<typeof vi.fn> } };
    ground: { setVisible: ReturnType<typeof vi.fn> };
    movement: { exit(position: { x: number; y: number }, report: () => void): void };
    doors: { reset: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    avatarVisual: { select(sprite: AvatarSpriteKey): void };
    inputGate: InputGate;
    avatarStudio: AvatarStudioController;
    roomControllers: Partial<Record<string, FixedRoomController>>;
    createAvatarOutfit(): void;
    createFixedRooms(): void;
    createAvatarStudio(): void;
    cleanShutdown(): void;
  };
  scene.map = map;
  scene.player = player;
  scene.input = { keyboard };
  scene.game = { registry: { get: (key) => (key === 'bus' ? bus : undefined) } };
  scene.physics = { world: { setBounds: vi.fn() } };
  scene.cameras = { main: { setBounds: vi.fn() } };
  scene.ground = { setVisible: vi.fn() };
  scene.movement = { exit: (_position, report) => report() };
  scene.doors = { reset: vi.fn(), update: vi.fn() };
  const attachAvatarVisual = (): void => {
    scene.avatarVisual = { select: (sprite) => applied.push(sprite) };
  };
  attachAvatarVisual();
  scene.inputGate = createInputGate({
    enabled: true,
    disableGlobalCapture: vi.fn(),
    enableGlobalCapture: vi.fn(),
    resetKeys: vi.fn(),
  });
  scene.createAvatarOutfit();
  scene.createFixedRooms();
  scene.createAvatarStudio();

  return {
    scene,
    keyboard,
    press: () => keyboard.press({ repeat: false, target: null }),
    /** What a same-instance restart re-creates: the player, then the binding. */
    rebind: () => {
      attachAvatarVisual();
      scene.createAvatarOutfit();
    },
    /** What the local avatar is actually wearing. */
    selected: (): AvatarSpriteKey => applied.at(-1) ?? 'avatar-1',
    /** Every outfit the local avatar has been given, in order. */
    applied: (): readonly AvatarSpriteKey[] => [...applied],
    emitted: () => emitted.filter((entry) => entry.event === 'avatar:selected'),
    shellEmit: (event: string, payload: unknown) => {
      for (const handler of shellListeners.get(event) ?? []) handler(payload);
    },
    room: (building: string): FixedRoomController => {
      const controller = scene.roomControllers[building];
      if (!controller) throw new Error(`Missing room controller for ${building}`);
      return controller;
    },
    /**
     * The toggle is cosmetic. Its only outbound event is the existing
     * `avatar:selected` carrying the opaque sprite key — no stance, outfit,
     * wire, lobby, building or financial field, and no new event alongside the
     * ones the transitions under test already emit.
     */
    expectOnlySelectionOnTheWire: (alsoExpected: readonly string[]) => {
      const selections = emitted.filter((entry) => entry.event === 'avatar:selected');
      expect(selections.length).toBeGreaterThan(0);
      for (const entry of selections) {
        expect(Object.keys(entry.payload as object)).toEqual(['sprite']);
      }
      expect(new Set(emitted.map((entry) => entry.event))).toEqual(
        new Set(['avatar:selected', ...alsoExpected]),
      );
    },
  };
}

interface LifecycleKeyEvent {
  readonly repeat: boolean;
  readonly target: unknown;
}

class LifecycleKeyboard {
  private readonly handlers = new Set<(event: LifecycleKeyEvent) => void>();

  on(event: string, handler: (event: LifecycleKeyEvent) => void): this {
    if (event === 'keydown-F') this.handlers.add(handler);
    return this;
  }

  off(event: string, handler: (event: LifecycleKeyEvent) => void): this {
    if (event === 'keydown-F') this.handlers.delete(handler);
    return this;
  }

  listenerCount(): number {
    return this.handlers.size;
  }

  snapshot(): (event: LifecycleKeyEvent) => void {
    const handler = this.handlers.values().next().value;
    if (!handler) throw new Error('Missing keydown-F handler');
    return handler;
  }

  press(event: LifecycleKeyEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
