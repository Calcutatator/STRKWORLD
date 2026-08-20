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
  isAvatarStudioEntrance,
  isSolidAt,
  objectLayerToDoors,
  TILE_SIZE,
  TILES,
  tileToWorld,
  worldToTile,
} from './map/street.js';
export type {
  BuildingExteriorLabel,
  DistrictMap,
  DoorZone,
  HiddenRoomEntrance,
  TileKind,
  TileSpec,
} from './map/street.js';

// D-047 hidden, non-financial Avatar Studio. This registry and controller
// carry only cosmetic state; they do not use BuildingId or financial stations.
export {
  AVATAR_SPRITE_KEYS,
  DEFAULT_AVATAR_SPRITE,
  avatarSpriteForFigure,
  isAvatarSpriteKey,
  pairedAvatarSprite,
  validateAvatarSprite,
} from './avatar-state.js';
export type { AvatarSpriteKey } from '@strkworld/shared';

// D-053 World-local outfit toggle. One Scene-owned selection and one F
// binding, shared by the Studio and every fixed room. Cosmetic only: it
// resolves through pairedAvatarSprite and emits the existing avatar:selected.
export {
  createAvatarOutfitSelection,
  createAvatarOutfitToggleBinding,
} from './avatar-outfit.js';
export type { AvatarOutfitSelection, AvatarOutfitToggleBinding } from './avatar-outfit.js';
export {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_HEIGHT,
  AVATAR_STUDIO_TILE_SIZE,
  AVATAR_STUDIO_WIDTH,
  avatarStudioFigureAt,
  avatarStudioTileColour,
  createAvatarStudioPresentation,
  createAvatarStudioController,
  isAvatarStudioExit,
  isAvatarStudioSolidAt,
  validateAvatarStudioDefinition,
} from './avatar-studio.js';
export type {
  AvatarStudioController,
  AvatarStudioControllerOptions,
  AvatarStudioDefinition,
  AvatarStudioFigure,
  AvatarStudioRect,
  AvatarStudioState,
  AvatarStudioBounds,
  AvatarStudioPresentation,
  AvatarStudioPresentationPort,
} from './avatar-studio.js';

// Tiled object-layer property adapter. The seam a real Tiled export uses; see
// the trap it documents (object-layer props arrive as a raw array, unflattened).
export { flattenProperties } from './tiled-object-props.js';
export type { TiledObject, TiledProperty } from './tiled-object-props.js';

// Door triggers. The Phaser-free state machine that turns tile movement into
// building:entered / building:exited / building:locked on the world bus.
export { createDoorTrigger } from './door-trigger.js';
export type { DoorTrigger } from './door-trigger.js';

// Street movement is a Phaser-free adapter seam; lobby throttling remains
// outside this package's movement reporter.
export { createStreetMovementAdapter, createStreetMovementReporter } from './street-movement.js';
export type {
  MovementInput,
  StreetMovementAdapter,
  StreetMovementReporter,
} from './street-movement.js';

// Input gating. The shell suspends world input while a panel is open.
export { bindInputGate, createInputGate } from './input-gate.js';
export type { InputGate, KeyboardLike } from './input-gate.js';

// D-033's first fixed Game Mode room. Geometry and the interaction state
// machine are Phaser-free; the runtime scene is a thin rendering adapter.
export {
  BANK_ROOM_BUILDING,
  BANK_ROOM_TILE_SIZE,
  BANK_SHIELDING_LABEL,
  BANK_SHIELDING_STATION,
  bankRoomTileAt,
  createBankRoom,
  createBankRoomController,
  isBankRoomExit,
  isBankRoomSolidAt,
  isBankStationApproach,
  normalizeBankStationSnapshot,
} from './bank-room.js';

// D-039 fixed-room core.  The Bank facade above preserves its original
// public shape; new Game Mode rooms use this shared deep module directly.
export {
  BANK_ROOM_DEFINITION,
  BRIDGE_ROOM_DEFINITION,
  EXCHANGE_ROOM_DEFINITION,
  FIXED_ROOM_DEFINITIONS,
  FIXED_ROOM_TILE_SIZE,
  FixedRoomDefinitionError,
  POST_OFFICE_ROOM_DEFINITION,
  createFixedRoom,
  createFixedRoomController,
  fixedRoomStationAtApproach,
  fixedRoomStationPresentations,
  fixedRoomTileAt,
  isFixedRoomApproach,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  normalizeFixedRoomStations,
  validateFixedRoomDefinition,
} from './fixed-room.js';
export type {
  FixedRoomController,
  FixedRoomControllerOptions,
  FixedRoomDefinition,
  FixedRoomDefinitionErrorCode,
  FixedRoomInputGate,
  FixedRoomMap,
  FixedRoomRect,
  FixedRoomState,
  FixedRoomStationDefinition,
  FixedRoomStationPresentation,
  FixedRoomStationSnapshot,
  FixedRoomTile,
} from './fixed-room.js';
export type {
  BankRoomController,
  BankRoomControllerOptions,
  BankRoomMap,
  BankRoomRect,
  BankRoomState,
  BankRoomTile,
  BankStationSnapshot,
  RoomInputGate,
} from './bank-room.js';

// D-038 retained full-snapshot seam. The Shell receives only `source`; its
// publisher/controller is kept outside Phaser and is never imported by the
// World runtime.
export {
  createRemotePeerSource,
  reconcileRemotePeers,
  validateRemotePeer,
  DEFAULT_REMOTE_SPRITE,
  REMOTE_SPRITE_KEYS,
  REMOTE_WORLD_LIMIT,
} from './remote-peer.js';
export type {
  RemotePeerListener,
  RemotePeerSnapshot,
  RemotePeerSource,
  RemotePeerSourceController,
} from './remote-peer.js';
