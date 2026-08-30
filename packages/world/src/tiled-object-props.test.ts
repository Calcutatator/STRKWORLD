import { describe, expect, it } from 'vitest';
import { flattenProperties, type TiledObject, type TiledProperty } from './tiled-object-props.js';

describe('flattenProperties', () => {
  it('flattens a raw Tiled property array into a keyed object', () => {
    const raw: TiledProperty[] = [
      { name: 'building', type: 'string', value: 'bank' },
      { name: 'locked', type: 'bool', value: false },
    ];
    expect(flattenProperties(raw)).toEqual({ building: 'bank', locked: false });
  });

  it('encodes the trap: the raw array has no keyed access, the flattened object does', () => {
    // This is why the module exists. Phaser copies object-layer properties
    // through verbatim as an array (ParseObject.js + Pick.js), unlike tileset
    // tile-properties which it flattens (ParseTilesets.js). Reading `.building`
    // off the array is always undefined; flattening first is mandatory.
    const object: TiledObject = {
      x: 96,
      y: 320,
      width: 64,
      height: 32,
      properties: [{ name: 'building', type: 'string', value: 'exchange' }],
    };

    // The array itself has no `building` key — the shape people reach for by
    // mistake, expecting the tileset behaviour.
    expect((object.properties as unknown as Record<string, unknown>)['building']).toBeUndefined();

    // Flattened, it does.
    expect(flattenProperties(object.properties)['building']).toBe('exchange');
  });

  it('returns an empty object for missing or empty properties', () => {
    expect(flattenProperties(undefined)).toEqual({});
    expect(flattenProperties([])).toEqual({});
  });

  it('fails closed for a malformed non-array property container', () => {
    expect(flattenProperties({ name: 'building', value: 'bank' } as never)).toEqual({});
  });

  it('lets the last value win on a duplicate name, matching Phaser', () => {
    const raw: TiledProperty[] = [
      { name: 'building', type: 'string', value: 'bank' },
      { name: 'building', type: 'string', value: 'vault' },
    ];
    expect(flattenProperties(raw)['building']).toBe('vault');
  });

  it('preserves non-string value types (bool, number)', () => {
    const raw: TiledProperty[] = [
      { name: 'locked', type: 'bool', value: true },
      { name: 'level', type: 'int', value: 3 },
    ];
    const flat = flattenProperties(raw);
    expect(flat['locked']).toBe(true);
    expect(flat['level']).toBe(3);
  });

  it('skips malformed entries rather than throwing', () => {
    // A hand-edited map with one bad entry should not take down the layer.
    const raw = [
      { name: 'building', type: 'string', value: 'post-office' },
      { value: 'orphan' } as TiledProperty,
      null as unknown as TiledProperty,
    ];
    expect(flattenProperties(raw)).toEqual({ building: 'post-office' });
  });
});
