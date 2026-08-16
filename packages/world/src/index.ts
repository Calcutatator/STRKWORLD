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
  TILE_SIZE,
  TILES,
  tileToWorld,
  worldToTile,
} from './map/street.js';
export type { DistrictMap, DoorZone, TileKind, TileSpec } from './map/street.js';

// Input gating. The shell suspends world input while a panel is open.
export { bindInputGate, createInputGate } from './input-gate.js';
export type { InputGate, KeyboardLike } from './input-gate.js';
