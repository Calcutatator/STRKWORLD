import { describe, expect, it, vi } from 'vitest';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { DEFAULT_AVATAR_SPRITE, pairedAvatarSprite } from '../avatar-state.js';
import type { AvatarStudioController } from '../avatar-studio.js';
import { FIXED_ROOM_DEFINITIONS, type FixedRoomController } from '../fixed-room.js';
import { createInputGate, type InputGate } from '../input-gate.js';
import { createStreetMap } from '../map/street.js';
import type { RemotePeerSource } from '../remote-peer.js';
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

  off(event: string, callback: () => void, context?: unknown): this {
    const listeners = this.listeners.get(event) ?? [];
    const retained = listeners.filter(
      (listener) => listener.callback !== callback || listener.context !== context,
    );
    if (retained.length === 0) this.listeners.delete(event);
    else this.listeners.set(event, retained);
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
    player: destroyable(),
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
  game?: { registry: { get(key: string): unknown } };
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
  player: { destroy(): void };
  ground?: { destroy(): void };
  avatarVisual?: { cycle: symbol };
  playerOwned: boolean;
  lastTile: { x: number; y: number };
}

function createHarness(initialBus?: {
  out: { emit(event: string, payload: unknown): void };
  in: { on(event: string, handler: (payload: unknown) => void): () => void };
  remotePeers?: RemotePeerSource;
}) {
  const SceneType = createStreetScene({ Phaser: { Scene: FakeScene } as never });
  const scene = new SceneType() as unknown as StreetSceneHarness;
  let current = cycleResources();
  let currentBus = initialBus;
  let failure: 'early' | 'partial' | null = null;
  let failureError: Error | undefined;

  if (initialBus) {
    scene.game = {
      registry: { get: (key: string) => (key === 'bus' ? currentBus : undefined) },
    };
  }

  scene.drawGround = vi.fn(() => {
    if (failure === 'early') throw new Error('early create failure');
    scene.ground = current.ground;
  });
  scene.createPlayer = vi.fn(() => {
    scene.player = current.player;
    scene.playerOwned = true;
    scene.avatarVisual = current.avatarVisual;
  });
  scene.createCamera = vi.fn();
  scene.createDoorTriggers = vi.fn();
  scene.createDoorOverlays = vi.fn(() => { scene.doorOverlays = [current.overlay]; });
  scene.createInput = vi.fn(() => { scene.inputGate = current.input; });
  scene.createAvatarOutfit = vi.fn(() => { scene.avatarOutfitToggle = current.outfitToggle; });
  scene.createFixedRooms = vi.fn(() => { scene.roomControllers = { bank: current.controller }; });
  scene.createAvatarStudio = vi.fn(() => {
    if (failure === 'partial') {
      failureError = new Error('partial create failure');
      throw failureError;
    }
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
    setBus(next: typeof initialBus) {
      currentBus = next;
    },
    failAt(next: typeof failure) {
      failure = next;
    },
    failureError: () => failureError,
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
  it('retries the same Avatar Studio tile after selection delivery fails', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    harness.scene.avatarStudio.enter();

    const error = new Error('selection delivery failed');
    harness.failNextAvatarSelection(error);
    harness.scene.player.x = 64 + (5 + 0.5) * 32;
    harness.scene.player.y = 64 + (3 + 0.5) * 32;

    expect(() => harness.scene.reportAvatarStudioTile()).toThrow(error);
    expect(harness.scene.lastTile).toEqual({ x: -1, y: -1 });

    expect(() => harness.scene.reportAvatarStudioTile()).not.toThrow();
    expect(harness.selected()).toBe('avatar-2');
  });

  it('toggles the outfit outdoors, in the Studio and back, from one Scene-owned binding', () => {
    const harness = createWorldPlayHarness();
    harness.create();

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
    expect(harness.selected()).toBe('avatar-9');
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

    harness.expectOnlySelectionOnTheWire([
      'avatar-studio:entered',
      'avatar-studio:exited',
      'player:moved',
    ]);
  });

  it('keeps toggling inside every fixed-room interior', () => {
    const harness = createWorldPlayHarness();
    harness.create();
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

    harness.expectOnlySelectionOnTheWire(['building:exited', 'player:moved']);
  });

  it('is inactive while World gameplay input is suspended', () => {
    const harness = createWorldPlayHarness();
    harness.create();

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
    const harness = createWorldPlayHarness();
    harness.create();

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
    expect(harness.cycle().applied).toEqual([]);

    harness.press();
    expect(harness.selected()).toBe('avatar-9');
  });

  it('stops toggling after shutdown, including through a retained stale handler', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    harness.press();
    expect(harness.selected()).toBe('avatar-9');

    const stale = harness.keyboard.snapshot();
    harness.shutdown();
    harness.scene.cleanShutdown();
    expect(harness.keyboard.listenerCount()).toBe(0);

    harness.press();
    stale({ repeat: false, target: null });
    expect(harness.cycle().applied).toEqual(['avatar-9']);
  });

  it('does not report a street tile after movement delivery retires the Scene', () => {
    const harness = createWorldPlayHarness();
    harness.create();

    // A Shell/World listener can synchronously tear down the Scene while the
    // movement event is being delivered. The post-event tile report belongs
    // to that same Scene cycle and must not enter a room after cleanup.
    expect(() => harness.retireDuringNextStreetMovement()).not.toThrow();
    expect(harness.eventCount('building:entered')).toBe(0);
  });

  it('ignores a stale Scene update after shutdown', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    harness.shutdown();
    const movedBefore = harness.eventCount('player:moved');

    // Phaser normally stops its update loop during shutdown, but a queued
    // update can still arrive at this public Scene boundary. It must not
    // publish a movement sample from the retired cycle.
    expect(() => harness.scene.update(0, 16)).not.toThrow();
    expect(harness.eventCount('player:moved')).toBe(movedBefore);
  });

  it('retries Avatar Studio entry after a failed transition on the same tile', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    const error = new Error('studio entry failed');
    const enter = vi.spyOn(harness.scene.avatarStudio, 'enter')
      .mockImplementationOnce(() => { throw error; });
    const player = harness.scene.player as { x: number; y: number };
    player.x = 23 * 32 + 16;
    player.y = 27 * 32 + 16;
    harness.scene.cursors = {
      left: { isDown: false },
      right: { isDown: false },
      up: { isDown: false },
      down: { isDown: false },
      shift: { isDown: false },
    };

    expect(() => harness.scene.update(0, 16)).toThrow(error);
    expect(enter).toHaveBeenCalledOnce();
    expect(harness.scene.avatarStudio.state.inRoom).toBe(false);

    expect(() => harness.scene.update(0, 16)).not.toThrow();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(harness.scene.avatarStudio.state.inRoom).toBe(true);
    harness.shutdown();
  });

  it('does not retain Scene Studio mode when presentation entry fails', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    const error = new Error('studio presentation failed');
    vi.spyOn(harness.scene.avatarStudioPresentation, 'enter').mockImplementationOnce(() => {
      throw error;
    });

    expect(() => harness.scene.avatarStudio.enter()).toThrow(error);
    expect(harness.scene.avatarStudio.state.inRoom).toBe(false);
    expect(harness.scene.avatarStudioActive).toBe(false);

    expect(() => harness.scene.avatarStudio.enter()).not.toThrow();
    expect(harness.scene.avatarStudio.state.inRoom).toBe(true);
    expect(harness.scene.avatarStudioActive).toBe(true);

    harness.shutdown();
  });

  it('retains Scene Studio mode when presentation exit fails', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    harness.scene.avatarStudio.enter();
    const error = new Error('studio presentation exit failed');
    vi.spyOn(harness.scene.avatarStudioPresentation, 'exit').mockImplementationOnce(() => {
      throw error;
    });

    expect(() => harness.scene.avatarStudio.update({ x: 8, y: 0 })).toThrow(error);
    expect(harness.scene.avatarStudio.state.inRoom).toBe(true);
    expect(harness.scene.avatarStudioActive).toBe(true);

    expect(() => harness.scene.avatarStudio.update({ x: 8, y: 0 })).not.toThrow();
    expect(harness.scene.avatarStudio.state.inRoom).toBe(false);
    expect(harness.scene.avatarStudioActive).toBe(false);

    harness.shutdown();
  });

  it('retries fixed-room entry after a failed transition on the same tile', () => {
    const harness = createWorldPlayHarness();
    harness.create();
    const room = harness.room('bank');
    const error = new Error('fixed-room entry failed');
    const enter = vi.spyOn(room, 'enter')
      .mockImplementationOnce(() => { throw error; });
    const player = harness.scene.player as { x: number; y: number };
    player.x = 5 * 32 + 16;
    player.y = 10 * 32 + 16;
    harness.scene.cursors = {
      left: { isDown: false },
      right: { isDown: false },
      up: { isDown: false },
      down: { isDown: false },
      shift: { isDown: false },
    };

    expect(() => harness.scene.update(0, 16)).toThrow(error);
    expect(enter).toHaveBeenCalledOnce();

    // The player remains on the same door tile. A failed room handoff must
    // remain retryable instead of being hidden by the Scene's tile sentinel.
    expect(() => harness.scene.update(0, 16)).not.toThrow();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(room.state.inRoom).toBe(true);
    harness.shutdown();
  });

  it('rebinds the outfit toggle through the production create order on a restart', () => {
    // The ordering under test lives in create() itself: the Scene must make its
    // selection *before* it builds the Studio. Stubbing create() would hide a
    // swap, and after a restart the Studio would silently hold the no-op
    // selection left behind by cleanShutdown.
    const harness = createWorldPlayHarness();

    harness.create();
    expect(harness.cycles).toHaveLength(1);
    expect(harness.keyboard.listenerCount()).toBe(1);
    expect(harness.scene.avatarStudio.state.selected).toBe('avatar-1');
    harness.press();
    expect(harness.cycle(0).applied).toEqual(['avatar-9']);
    expect(harness.scene.avatarStudio.state.selected).toBe('avatar-9');

    const stale = harness.keyboard.snapshot();
    harness.shutdown();
    expect(harness.keyboard.listenerCount()).toBe(0);

    // Same instance, real create order again.
    harness.create();
    expect(harness.cycles).toHaveLength(2);
    expect(harness.keyboard.listenerCount()).toBe(1);
    // A restarted Scene starts from the default, and its Studio must hold
    // *this* cycle's selection — not the destroyed one, and not the no-op.
    expect(harness.scene.avatarStudio.state.selected).toBe('avatar-1');

    harness.press();
    expect(harness.cycle(1).applied).toEqual(['avatar-9']);
    expect(harness.scene.avatarStudio.state.selected).toBe('avatar-9');
    // The previous cycle's avatar was not driven by the new binding.
    expect(harness.cycle(0).applied).toEqual(['avatar-9']);

    // The cycle-1 handler is inert even though it was captured while live.
    stale({ repeat: false, target: null });
    expect(harness.cycle(0).applied).toEqual(['avatar-9']);
    expect(harness.cycle(1).applied).toEqual(['avatar-9']);

    harness.shutdown();
    expect(harness.keyboard.listenerCount()).toBe(0);
    harness.press();
    expect(harness.cycle(1).applied).toEqual(['avatar-9']);
  });

  it('retires prior World ownership without broadcasting shutdown when create repeats', () => {
    // The mounting regression this file's header warns about: create() can run
    // twice. The second cycle must replace every listener-owning controller,
    // not only the outfit binding.
    const harness = createWorldPlayHarness();
    const frameworkShutdown = vi.fn();
    harness.scene.events.once('shutdown', frameworkShutdown);
    harness.create();
    const staleBank = harness.room('bank');
    staleBank.enter();

    expect(staleBank.state.inRoom).toBe(true);
    expect(harness.shellListenerCount()).toBe(12);

    harness.create();

    expect(frameworkShutdown).not.toHaveBeenCalled();
    expect(harness.cycles).toHaveLength(2);
    expect(harness.keyboard.listenerCount()).toBe(1);
    expect(staleBank.state.inRoom).toBe(false);
    expect(harness.shellListenerCount()).toBe(12);
    expect(harness.scene.events.count('shutdown')).toBe(3);

    // A late Shell exit reaches only the current, outside controller. The
    // retired Bank must not move the new Scene or publish a stale exit.
    harness.shellEmit('world:exit-building', { building: 'bank' });
    expect(harness.eventCount('building:exited')).toBe(0);

    harness.press();
    expect(harness.cycle(1).applied).toEqual(['avatar-9']);
    expect(harness.cycle(0).applied).toEqual([]);

    harness.shutdown();
    expect(frameworkShutdown).toHaveBeenCalledTimes(1);
    expect(harness.keyboard.listenerCount()).toBe(0);
    expect(harness.shellListenerCount()).toBe(0);
    expect(harness.scene.events.count('shutdown')).toBe(0);
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

  it('replaces the registry-owned remote peer source on a retained Scene restart', () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    const firstSource: RemotePeerSource = {
      subscribe: vi.fn(() => firstStop),
    };
    const secondSource: RemotePeerSource = {
      subscribe: vi.fn(() => secondStop),
    };
    const bus = (remotePeers: RemotePeerSource) => ({
      out: { emit: vi.fn() },
      in: { on: vi.fn(() => vi.fn()) },
      remotePeers,
    });
    const harness = createHarness(bus(firstSource));

    harness.create();
    harness.setBus(bus(secondSource));
    harness.nextCycle();
    harness.create();

    expect(firstSource.subscribe).toHaveBeenCalledOnce();
    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondSource.subscribe).toHaveBeenCalledOnce();
    expect(secondStop).not.toHaveBeenCalled();

    harness.shutdown();
    expect(secondStop).toHaveBeenCalledOnce();
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
    expect(harness.scene.events.count('shutdown')).toBe(0);
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
    expect(harness.scene.events.count('shutdown')).toBe(0);
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

  it('cleans a failed create immediately when Phaser emits no shutdown', () => {
    const harness = createHarness();
    const partial = harness.nextCycle();
    harness.failAt('partial');

    expect(() => harness.create()).toThrow('partial create failure');

    expect(partial.player.destroy).toHaveBeenCalledOnce();
    expect(partial.ground.destroy).toHaveBeenCalledOnce();
    expect(partial.controller.destroy).toHaveBeenCalledOnce();
    expect(partial.unsubscribe).toHaveBeenCalledOnce();
    expect(partial.input.resume).toHaveBeenCalledOnce();
    expect(partial.overlay.destroy).toHaveBeenCalledOnce();
    expect(partial.outfitToggle.destroy).toHaveBeenCalledOnce();
    expect(harness.scene.remoteLayers[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.scene.events.count('shutdown')).toBe(0);

    // A later framework shutdown and explicit idempotence call cannot double
    // destroy the failed cycle, and the same Scene can still recover.
    harness.shutdown();
    harness.scene.cleanShutdown();
    expect(partial.player.destroy).toHaveBeenCalledOnce();
    expect(partial.controller.destroy).toHaveBeenCalledOnce();

    const recovered = harness.nextCycle();
    harness.failAt(null);
    harness.create();
    harness.shutdown();
    expectCompleteCleanup(recovered);
  });

  it('preserves the create error and continues cleanup when a destructor throws', () => {
    const harness = createHarness();
    const partial = harness.nextCycle();
    const cleanupError = new Error('ground destroy failed');
    partial.ground.destroy.mockImplementation(() => {
      throw cleanupError;
    });
    harness.failAt('partial');

    let thrown: unknown;
    try {
      harness.create();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(harness.failureError());
    expect(thrown).toBeInstanceOf(Error);
    expect(partial.player.destroy).toHaveBeenCalledOnce();
    expect(partial.ground.destroy).toHaveBeenCalledOnce();
    expect(partial.controller.destroy).toHaveBeenCalledOnce();
    expect(partial.unsubscribe).toHaveBeenCalledOnce();
    expect(partial.input.resume).toHaveBeenCalledOnce();
    expect(partial.overlay.destroy).toHaveBeenCalledOnce();
    expect(partial.outfitToggle.destroy).toHaveBeenCalledOnce();
    expect(harness.scene.remoteLayers[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.scene.events.count('shutdown')).toBe(0);
  });

  it('propagates framework cleanup errors after attempting every teardown', () => {
    const harness = createHarness();
    const cycle = harness.nextCycle();
    harness.create();
    const cleanupError = new Error('ground destroy failed');
    cycle.ground.destroy.mockImplementation(() => {
      throw cleanupError;
    });

    expect(() => harness.shutdown()).toThrow(cleanupError);
    expect(cycle.player.destroy).toHaveBeenCalledOnce();
    expect(cycle.controller.destroy).toHaveBeenCalledOnce();
    expect(cycle.unsubscribe).toHaveBeenCalledOnce();
    expect(cycle.input.resume).toHaveBeenCalledOnce();
    expect(cycle.overlay.destroy).toHaveBeenCalledOnce();
    expect(cycle.outfitToggle.destroy).toHaveBeenCalledOnce();
    expect(harness.scene.remoteLayers[0]?.destroy).toHaveBeenCalledOnce();
    harness.scene.cleanShutdown();
    expect(cycle.player.destroy).toHaveBeenCalledOnce();
    expect(cycle.controller.destroy).toHaveBeenCalledOnce();
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

/**
 * A Scene driven through its real `create()`.
 *
 * Only the Phaser-heavy presentation steps are stubbed. `create()` itself and
 * the seams under test — the outfit selection and binding, the fixed rooms, the
 * door triggers and the Avatar Studio — all run for real, so the production
 * *order* of those steps is covered too. That order is load-bearing: the Studio
 * is handed the Scene's selection, and building it first would hand it the
 * no-op selection instead, which changes nothing visible until someone presses
 * F.
 *
 * `createPlayer` records one avatar per create, so a restart has to be shown
 * driving the avatar it just built rather than the previous cycle's.
 */
function createWorldPlayHarness() {
  const SceneType = createStreetScene({ Phaser: { Scene: FakeScene } as never });
  const keyboard = new LifecycleKeyboard();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const shellListeners = new Map<string, Set<(payload: unknown) => void>>();
  let retireOnMovement = false;
  let failNextAvatarSelection: Error | undefined;
  const bus = {
    out: {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
        if (event === 'avatar:selected' && failNextAvatarSelection !== undefined) {
          const error = failNextAvatarSelection;
          failNextAvatarSelection = undefined;
          throw error;
        }
        if (retireOnMovement && event === 'player:moved') {
          retireOnMovement = false;
          scene.cleanShutdown();
        }
      },
    },
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
    body: { setEnable: vi.fn(), setVelocity: vi.fn() },
    setVelocity: vi.fn(),
    setPosition: vi.fn((x: number, y: number) => {
      player.x = x;
      player.y = y;
    }),
  };
  const cycles: Array<{ applied: AvatarSpriteKey[] }> = [];
  const scene = new SceneType() as unknown as WorldPlayScene;

  // preload() is what normally supplies the map.
  scene.map = createStreetMap();
  scene.player = player;
  scene.input = { keyboard };
  scene.game = { registry: { get: (key: string) => (key === 'bus' ? bus : undefined) } };
  scene.physics = { world: { setBounds: vi.fn() } };
  scene.cameras = { main: { setBounds: vi.fn() } };

  scene.drawGround = vi.fn();
  scene.createDoorOverlays = vi.fn(() => {
    scene.doorOverlays = [];
  });
  scene.createPlayer = vi.fn(() => {
    const cycle = { applied: [] as AvatarSpriteKey[] };
    cycles.push(cycle);
    scene.avatarVisual = {
      select: (sprite: AvatarSpriteKey) => cycle.applied.push(sprite),
      update: vi.fn(),
    };
  });
  scene.createInput = vi.fn(() => {
    scene.inputGate = createInputGate({
      enabled: true,
      disableGlobalCapture: vi.fn(),
      enableGlobalCapture: vi.fn(),
      resetKeys: vi.fn(),
    });
  });
  scene.createCamera = vi.fn();
  scene.createRoomVisuals = vi.fn();
  scene.createExteriorLabels = vi.fn();

  const cycle = (index = cycles.length - 1): { applied: AvatarSpriteKey[] } => {
    const record = cycles[index];
    if (!record) throw new Error(`No create cycle ${index}`);
    return record;
  };

  return {
    scene,
    keyboard,
    cycles,
    cycle,
    create: () => scene.create(),
    shutdown: () => scene.events.emit('shutdown'),
    press: () => keyboard.press({ repeat: false, target: null }),
    /**
     * What the local avatar is wearing.
     *
     * Both guards are load-bearing. A missing `avatarVisual` would make every
     * "unchanged" assertion pass for the wrong reason, and a Studio reading a
     * different key is exactly the divergence D-053 exists to prevent.
     */
    selected: (): AvatarSpriteKey => {
      expect(scene.avatarVisual).toBeDefined();
      const worn = cycle().applied.at(-1) ?? DEFAULT_AVATAR_SPRITE;
      expect(scene.avatarStudio.state.selected).toBe(worn);
      return worn;
    },
    shellEmit: (event: string, payload: unknown) => {
      for (const handler of shellListeners.get(event) ?? []) handler(payload);
    },
    shellListenerCount: () =>
      [...shellListeners.values()].reduce((total, handlers) => total + handlers.size, 0),
    eventCount: (event: string) => emitted.filter((entry) => entry.event === event).length,
    failNextAvatarSelection: (error: Error) => {
      failNextAvatarSelection = error;
    },
    retireDuringNextStreetMovement: () => {
      player.x = 5 * 32 + 16;
      player.y = 10 * 32 + 16;
      scene.cursors = {
        left: { isDown: false },
        right: { isDown: true },
        up: { isDown: false },
        down: { isDown: false },
        shift: { isDown: false },
      };
      retireOnMovement = true;
      scene.update(0, 16);
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

interface WorldPlayScene extends FakeScene {
  map: ReturnType<typeof createStreetMap>;
  player: { x: number; y: number };
  lastTile: { x: number; y: number };
  cursors: {
    left: { isDown: boolean };
    right: { isDown: boolean };
    up: { isDown: boolean };
    down: { isDown: boolean };
    shift: { isDown: boolean };
  };
  input: { keyboard: LifecycleKeyboard };
  game: { registry: { get(key: string): unknown } };
  physics: { world: { setBounds: ReturnType<typeof vi.fn> } };
  cameras: { main: { setBounds: ReturnType<typeof vi.fn> } };
  doorOverlays: unknown[];
  avatarVisual?: { select(sprite: AvatarSpriteKey): void; update(input: unknown, sprinting: boolean): void };
  inputGate: InputGate;
  avatarStudio: AvatarStudioController;
  avatarStudioActive: boolean;
  avatarStudioPresentation: { enter(): void; exit(): void; destroy(): void };
  roomControllers: Partial<Record<string, FixedRoomController>>;
  create(): void;
  cleanShutdown(): void;
  drawGround(): void;
  createDoorOverlays(): void;
  createPlayer(): void;
  createInput(): void;
  createCamera(): void;
  createRoomVisuals(): void;
  createExteriorLabels(): void;
  update(time: number, delta: number): void;
  reportAvatarStudioTile(): void;
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
