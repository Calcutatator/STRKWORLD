import { describe, expect, it, vi } from 'vitest';
import { createStreetMap } from '../map/street.js';
import { createStreetScene } from './street-scene.js';

vi.mock('../kenney-urban.js', () => ({
  createKenneyRuntimeTextures: vi.fn(),
  KENNEY_ATLAS_KEY: 'kenney-atlas',
  KENNEY_ATLAS_URL: '/kenney-atlas.png',
  KENNEY_DOOR_TEXTURE_KEY: 'kenney-door',
  KENNEY_TILE_TEXTURE_KEY: 'kenney-tiles',
}));

class FakeScene {
  constructor(_config: unknown) {}
}

interface CameraSceneHarness {
  map: ReturnType<typeof createStreetMap>;
  player: object;
  cameras: {
    main: {
      setBounds: ReturnType<typeof vi.fn>;
      startFollow: ReturnType<typeof vi.fn>;
      setZoom: ReturnType<typeof vi.fn>;
    };
  };
  createCamera(): void;
}

describe('StreetScene camera', () => {
  it('tracks horizontal motion immediately while retaining vertical smoothing', () => {
    const SceneType = createStreetScene({ Phaser: { Scene: FakeScene } as never });
    const scene = new SceneType() as unknown as CameraSceneHarness;
    const player = { x: 768, y: 496 };
    const camera = {
      setBounds: vi.fn(),
      startFollow: vi.fn(),
      setZoom: vi.fn(),
    };
    scene.map = createStreetMap();
    scene.player = player;
    scene.cameras = { main: camera };

    scene.createCamera();

    expect(camera.setBounds).toHaveBeenCalledOnce();
    expect(camera.setBounds).toHaveBeenCalledWith(0, 0, 1536, 896);
    expect(camera.startFollow).toHaveBeenCalledOnce();
    expect(camera.startFollow).toHaveBeenCalledWith(player, true, 1, 0.12);
    expect(camera.setZoom).toHaveBeenCalledOnce();
    expect(camera.setZoom).toHaveBeenCalledWith(2);
  });
});
