import { describe, expect, it } from 'vitest';
import {
  KENNEY_ATLAS,
  KENNEY_ATLAS_KEY,
  KENNEY_ATLAS_URL,
  KENNEY_DOOR_TEXTURE_KEY,
  KENNEY_TILE_TEXTURE_KEY,
  KENNEY_TILE_ROLES,
  atlasFrameRect,
  createKenneyRuntimeTextures,
  kenneyTileForRole,
  validateKenneyAtlas,
} from './kenney-urban.js';

describe('Kenney Urban runtime atlas contract', () => {
  it('uses the audited 16px grid and derives row-major source rectangles', () => {
    expect(KENNEY_ATLAS).toMatchObject({
      width: 458,
      height: 305,
      tileWidth: 16,
      tileHeight: 16,
      spacing: 1,
      columns: 27,
      rows: 18,
      scale: 2,
      runtimeTileSize: 32,
    });
    expect(atlasFrameRect(468)).toEqual({ x: 153, y: 289, width: 16, height: 16 });
    expect(atlasFrameRect(109)).toEqual({ x: 17, y: 68, width: 16, height: 16 });
    expect(atlasFrameRect(72)).toEqual({ x: 306, y: 34, width: 16, height: 16 });
    expect(atlasFrameRect(99)).toEqual({ x: 306, y: 51, width: 16, height: 16 });
    expect(atlasFrameRect(284)).toEqual({ x: 238, y: 170, width: 16, height: 16 });
  });

  it('does not let consumers rewrite the runtime atlas authority', () => {
    expect(Object.isFrozen(KENNEY_ATLAS)).toBe(true);
    expect(Reflect.set(KENNEY_ATLAS, 'columns', 1)).toBe(false);
    expect(KENNEY_ATLAS.columns).toBe(27);
  });

  it('pins only the approved mappings and leaves grass and roof out of the atlas roles', () => {
    expect(KENNEY_TILE_ROLES).toEqual(['road', 'pavement', 'wall', 'facade', 'door']);
    expect(kenneyTileForRole('road')).toEqual({
      role: 'road',
      frame: 468,
      rect: { x: 153, y: 289, width: 16, height: 16 },
      runtimeWidth: 32,
      runtimeHeight: 32,
    });
    expect(kenneyTileForRole('pavement')).toMatchObject({
      frame: 109,
      rect: { x: 17, y: 68, width: 16, height: 16 },
    });
    expect(kenneyTileForRole('wall').frame).toBe(72);
    expect(kenneyTileForRole('facade').frame).toBe(99);
    expect(kenneyTileForRole('door')).toMatchObject({
      frame: 284,
      rect: { x: 238, y: 170, width: 16, height: 16 },
    });
    expect(() => kenneyTileForRole('grass' as never)).toThrow(/unsupported/i);
    expect(() => kenneyTileForRole('roof' as never)).toThrow(/unsupported/i);
  });

  it('rejects a source whose dimensions cannot represent the audited grid', () => {
    expect(() => validateKenneyAtlas({ ...KENNEY_ATLAS, width: 457 })).toThrow(/width/i);
    expect(() => validateKenneyAtlas({ ...KENNEY_ATLAS, spacing: -1 })).toThrow(/spacing/i);
    expect(() => atlasFrameRect(-1)).toThrow(/frame/i);
    expect(() => atlasFrameRect(486)).toThrow(/frame/i);
  });

  it('keeps asset keys and URL resolution explicit for Vite', () => {
    expect(KENNEY_ATLAS_KEY).toBe('kenney-rpg-urban-atlas');
    expect(KENNEY_TILE_TEXTURE_KEY).toBe('tiles');
    expect(KENNEY_DOOR_TEXTURE_KEY).toBe('kenney-rpg-urban-door');
    expect(KENNEY_ATLAS_URL).toContain('/assets/third-party/kenney-rpg-urban/tilemap.png');
  });

  it('does not strand a partial tileset when door texture allocation fails', () => {
    const textures = new Map<string, object>();
    let doorAttempts = 0;
    const makeTexture = () => ({
      context: {
        imageSmoothingEnabled: true,
        fillStyle: '',
        fillRect: () => undefined,
        drawImage: () => undefined,
      },
      refresh: () => undefined,
      setFilter: () => undefined,
    });
    const textureManager = {
      exists: (key: string) => textures.has(key),
      get: () => ({ getSourceImage: () => ({}) }),
      createCanvas: (key: string) => {
        if (key === KENNEY_DOOR_TEXTURE_KEY && doorAttempts++ === 0) return null;
        const texture = makeTexture();
        textures.set(key, texture);
        return texture;
      },
      remove: (key: string) => {
        textures.delete(key);
      },
    };
    const scene = { textures: textureManager } as never;
    const Phaser = { Textures: { FilterMode: { NEAREST: 0 } } } as never;
    const options = {
      tileIndex: { grass: 0, road: 1, pavement: 2, wall: 3, facade: 4 },
      grassColour: 0x123456,
    } as const;

    expect(() => createKenneyRuntimeTextures(scene, Phaser, options)).toThrow(
      'Could not create Kenney runtime textures',
    );
    expect(textures.has(KENNEY_TILE_TEXTURE_KEY)).toBe(false);

    // Also cover a stale half-pair left by another owner or an older runtime.
    textures.set(KENNEY_TILE_TEXTURE_KEY, makeTexture());
    expect(() => createKenneyRuntimeTextures(scene, Phaser, options)).not.toThrow();
    expect(textures.has(KENNEY_TILE_TEXTURE_KEY)).toBe(true);
    expect(textures.has(KENNEY_DOOR_TEXTURE_KEY)).toBe(true);
    expect(doorAttempts).toBe(2);
  });
});
