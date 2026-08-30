/**
 * Tiled object-layer custom properties, flattened to a keyed object.
 *
 * ── THE TRAP (verified against phaser@4.2.1 source, not documentation) ──
 *
 * Phaser parses object-layer properties and tileset tile-properties through
 * DIFFERENT code paths, and only one of them flattens:
 *
 *  - Tileset tile-properties ARE flattened to a keyed object.
 *    `src/tilemaps/parsers/tiled/ParseTilesets.js` does, per tile:
 *        tile.properties.forEach(p => newPropData[p.name] = p.value)
 *    so `tileset.tileProperties[id]` is `{ building: 'bank' }`.
 *
 *  - Object-layer object-properties are NOT flattened.
 *    `src/tilemaps/parsers/tiled/ParseObject.js` builds the parsed object with
 *    `Pick(tiledObject, [...,'properties',...])`, and `utils/object/Pick.js`
 *    copies each listed key VERBATIM. So a parsed object keeps Tiled's raw
 *    `properties: [{ name, type, value }]` ARRAY. `object.properties.building`
 *    is therefore always `undefined` — you must read `.name`/`.value` off the
 *    array yourself.
 *
 * Anything that keys door zones (or any trigger) off a `building` property on a
 * Tiled object layer must flatten first. That flattening lives here, alone, so
 * it has its own test and one obvious place to look when a real Tiled export
 * replaces the procedural map. The map's door data feeds through this module
 * today, so the seam a Tiled loader will use is already the seam under test.
 */

/**
 * One raw Tiled custom property, as it appears in exported JSON and as Phaser
 * passes it through for object layers.
 */
export interface TiledProperty {
  name: string;
  /**
   * Tiled's declared type: 'string' | 'bool' | 'int' | 'float' | 'color' |
   * 'file' | 'object' | 'class'. Ignored when flattening — Phaser's own
   * tileset flattener ignores it too — but kept for fidelity with the export.
   */
  type?: string;
  value: unknown;
}

/**
 * A parsed Tiled object-layer object, in the shape Phaser produces. Coordinates
 * are in PIXELS (Tiled convention); `properties` is the raw, un-flattened array.
 */
export interface TiledObject {
  id?: number;
  name?: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  properties?: TiledProperty[];
}

/**
 * Flatten a raw Tiled property array into a keyed object.
 *
 * Mirrors Phaser's tileset behaviour exactly: `name -> value`, type discarded,
 * last value wins on a duplicate name. A missing or empty array yields `{}`.
 * Malformed entries (no string `name`) are skipped rather than throwing, so one
 * bad property in a hand-edited map cannot take down the whole layer.
 */
export function flattenProperties(properties?: TiledProperty[]): Record<string, unknown> {
  // Tiled property names are data, not trusted object keys. A null prototype
  // keeps `__proto__` from changing the record's inheritance and prevents a
  // polluted ambient prototype from supplying a missing property later.
  const flat: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (!Array.isArray(properties)) return flat;
  for (const prop of properties) {
    if (prop && typeof prop.name === 'string') {
      flat[prop.name] = prop.value;
    }
  }
  return flat;
}
