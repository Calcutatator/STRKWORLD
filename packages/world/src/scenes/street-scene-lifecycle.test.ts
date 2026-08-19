import { describe, expect, it, vi } from 'vitest';
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

function cycleResources() {
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    controller: { destroy: vi.fn(() => unsubscribe()) },
    studio: destroyable(),
    roomGraphics: destroyable(),
    stationGraphics: destroyable(),
    studioGraphics: destroyable(),
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
  createFixedRooms(): void;
  createAvatarStudio(): void;
  createCamera(): void;
  createDoorTriggers(): void;
  createRoomVisuals(): void;
  createExteriorLabels(): void;
  roomControllers: Record<string, { destroy(): void }>;
  avatarStudio: { destroy(): void };
  inputGate: { resume(): void };
  roomGraphics: { destroy(): void };
  roomStationGraphics: { destroy(): void };
  avatarStudioGraphics: { destroy(): void };
  roomLabels: Map<string, { destroy(): void }>;
  exteriorLabels: Map<string, { destroy(): void }>;
  doorOverlays: Array<{ destroy(): void }>;
  ground?: { destroy(): void };
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
  scene.createPlayer = vi.fn();
  scene.createCamera = vi.fn();
  scene.createDoorTriggers = vi.fn();
  scene.createDoorOverlays = vi.fn(() => { scene.doorOverlays = [current.overlay]; });
  scene.createInput = vi.fn(() => { scene.inputGate = current.input; });
  scene.createFixedRooms = vi.fn(() => { scene.roomControllers = { bank: current.controller }; });
  scene.createAvatarStudio = vi.fn(() => {
    if (failure === 'partial') throw new Error('partial create failure');
    scene.avatarStudio = current.studio;
  });
  scene.createRoomVisuals = vi.fn(() => {
    scene.roomGraphics = current.roomGraphics;
    scene.roomStationGraphics = current.stationGraphics;
    scene.avatarStudioGraphics = current.studioGraphics;
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
  expect(cycle.roomGraphics.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.stationGraphics.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.studioGraphics.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.roomLabel.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.exteriorLabel.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.overlay.destroy).toHaveBeenCalledTimes(1);
  expect(cycle.input.resume).toHaveBeenCalledTimes(1);
}

describe('StreetScene lifecycle', () => {
  it('cleans every same-instance restart once while repeated shutdown stays idempotent', () => {
    const harness = createHarness();
    const cycles = [harness.current];

    harness.create();
    expect(harness.scene.events.count('shutdown')).toBe(2);
    harness.shutdown();
    harness.scene.cleanShutdown();

    cycles.push(harness.nextCycle());
    harness.create();
    expect(harness.scene.events.count('shutdown')).toBe(2);
    harness.shutdown();
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
