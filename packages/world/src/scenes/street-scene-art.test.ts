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
});
