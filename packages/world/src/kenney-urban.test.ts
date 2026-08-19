import { describe, expect, it } from 'vitest';
import {
  KENNEY_ATLAS,
  KENNEY_ATLAS_KEY,
  KENNEY_ATLAS_URL,
  KENNEY_DOOR_TEXTURE_KEY,
  KENNEY_TILE_TEXTURE_KEY,
  KENNEY_TILE_ROLES,
  atlasFrameRect,
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
});
