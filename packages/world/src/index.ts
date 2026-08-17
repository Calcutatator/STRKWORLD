/**
 * @strkworld/world — the game.
 *
 * Phaser scenes, movement, tilemaps, sprites. Knows nothing about wallets or
 * money. See README.md before changing anything here.
 *
 * Implementation lands in Phase 1. See docs/SPEC.md §8.
 */

// Map data and geometry. Phaser-free, so the shell and tests can use it.
export {
  createStreetMap,
  doorAt,
  isSolidAt,
  objectLayerToDoors,
  TILE_SIZE,
  TILES,
  tileToWorld,
  worldToTile,
} from './map/street.js';
export type { DistrictMap, DoorZone, TileKind, TileSpec } from './map/street.js';

// Tiled object-layer property adapter. The seam a real Tiled export uses; see
// the trap it documents (object-layer props arrive as a raw array, unflattened).
export { flattenProperties } from './tiled-object-props.js';
export type { TiledObject, TiledProperty } from './tiled-object-props.js';

// Door triggers. The Phaser-free state machine that turns tile movement into
// building:entered / building:exited / building:locked on the world bus.
export { createDoorTrigger } from './door-trigger.js';
export type { DoorTrigger } from './door-trigger.js';

// Input gating. The shell suspends world input while a panel is open.
export { bindInputGate, createInputGate } from './input-gate.js';
export type { InputGate, KeyboardLike } from './input-gate.js';
