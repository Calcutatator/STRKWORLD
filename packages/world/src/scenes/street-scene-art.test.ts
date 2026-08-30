import { describe, expect, it, vi } from 'vitest';
import { createStreetMap } from '../map/street.js';
import { createStreetScene, doorOverlayLayout } from './street-scene.js';

describe('street Kenney door presentation', () => {
  it('keeps the two-tile trigger but centers a native-size door over a facade surround', () => {
    const bankDoor = createStreetMap().doors.find((door) => door.building === 'bank')!;

    expect(bankDoor).toMatchObject({ x: 5, y: 10, width: 2, height: 1 });
    expect(doorOverlayLayout(bankDoor)).toEqual({
      x: 6 * 32,
      y: 10.5 * 32,
      width: 64,
      height: 32,
    });
  });

  it('retains an overlay before presentation setters can throw', () => {
    const presentationError = new Error('door presentation failed');
    const overlay = {
      setDisplaySize: vi.fn(() => {
        throw presentationError;
      }),
      setDepth: vi.fn(),
    };
    const SceneType = createStreetScene({ Phaser: { Scene: class {} } as never });
    const scene = new SceneType() as unknown as {
      map: ReturnType<typeof createStreetMap>;
      add: { image: ReturnType<typeof vi.fn> };
      doorOverlays: unknown[];
      createDoorOverlays(): void;
    };
    scene.map = createStreetMap();
    scene.doorOverlays = [];
    scene.add = { image: vi.fn(() => overlay) };

    expect(() => scene.createDoorOverlays()).toThrow(presentationError);
    expect(scene.doorOverlays).toEqual([overlay]);
  });

  it('retains the ground layer before collision setup can throw', () => {
    const collisionError = new Error('ground collision setup failed');
    const layer = {
      setDepth: vi.fn(function setDepth(this: typeof layer) { return this; }),
      setCollision: vi.fn(() => {
        throw collisionError;
      }),
    };
    const tilemap = {
      addTilesetImage: vi.fn(() => ({})),
      createLayer: vi.fn(() => layer),
    };
    const SceneType = createStreetScene({ Phaser: { Scene: class {} } as never });
    const scene = new SceneType() as unknown as {
      map: ReturnType<typeof createStreetMap>;
      make: { tilemap: ReturnType<typeof vi.fn> };
      ground?: typeof layer;
      drawGround(): void;
    };
    scene.map = createStreetMap();
    scene.ground = undefined;
    scene.make = { tilemap: vi.fn(() => tilemap) };

    expect(() => scene.drawGround()).toThrow(collisionError);
    expect(scene.ground).toBe(layer);
  });

  it('retains room graphics before depth setup can throw', () => {
    const depthError = new Error('room graphics depth setup failed');
    const graphics = {
      setDepth: vi.fn(() => {
        throw depthError;
      }),
    };
    const SceneType = createStreetScene({ Phaser: { Scene: class {} } as never });
    const scene = new SceneType() as unknown as {
      add: { graphics: ReturnType<typeof vi.fn> };
      roomGraphics?: typeof graphics;
      createRoomVisuals(): void;
    };
    scene.roomGraphics = undefined;
    scene.add = { graphics: vi.fn(() => graphics) };

    expect(() => scene.createRoomVisuals()).toThrow(depthError);
    expect(scene.roomGraphics).toBe(graphics);
  });
});
