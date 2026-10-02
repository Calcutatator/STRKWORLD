/**
 * @strkworld/world — the game.
 *
 * A tile-authored gameplay session drawn by a Three.js renderer (D-059).
 * Knows nothing about wallets or money. See README.md before changing
 * anything here.
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
  westRoadColumn,
  worldToTile,
} from './map/street.js';
export type {
  BuildingExteriorLabel,
  DistrictMap,
  DoorZone,
  HiddenRoomEntrance,
  StreetMapOptions,
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

// D-058 presentational projection for Web's manual-wallet attention cue: the
// default figure's walk, pre-rendered offline from the 3D model
// (tools/render-avatar-walker.ts). It carries only the asset URL and strip
// geometry; Web receives no three.js object and no movement authority.
export { AVATAR_WALKER } from './avatar-walker.js';
export type { AvatarWalkerStrip } from './avatar-walker.js';

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
// The Vault's room is outside the always-open table: it exists only when the
// Shell opens its door (D-077), so rooms are built from
// `fixedRoomDefinitionsFor`.
export {
  BANK_ROOM_DEFINITION,
  BRIDGE_ROOM_DEFINITION,
  EXCHANGE_DEGEN_LEVEL,
  EXCHANGE_DEGEN_STATION,
  EXCHANGE_ROOF_HEIGHT,
  EXCHANGE_ROOF_LEVEL,
  EXCHANGE_ROOM_DEFINITION,
  FIXED_ROOM_DEFINITIONS,
  FIXED_ROOM_LEVELS,
  FIXED_ROOM_TILE_SIZE,
  FixedRoomDefinitionError,
  POST_OFFICE_ROOM_DEFINITION,
  VAULT_BORROW_STATION,
  VAULT_LENDING_STATION,
  VAULT_ROOM_DEFINITION,
  createFixedRoom,
  createFixedRoomController,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  fixedRoomLiftAt,
  fixedRoomStationAtApproach,
  fixedRoomStationPresentations,
  fixedRoomTileAt,
  isFixedRoomApproach,
  isFixedRoomExit,
  isFixedRoomSolidAt,
  normalizeFixedRoomStations,
  validateFixedRoomDefinition,
  validateFixedRoomLevel,
  validateFixedRoomLevels,
} from './fixed-room.js';
export type {
  FixedRoomController,
  FixedRoomControllerOptions,
  FixedRoomDefinition,
  FixedRoomDefinitionErrorCode,
  FixedRoomFixture,
  FixedRoomFloorDefinition,
  FixedRoomInputGate,
  FixedRoomLevelDefinition,
  FixedRoomLevelId,
  FixedRoomLevelMap,
  FixedRoomLiftDefinition,
  FixedRoomMap,
  FixedRoomProp,
  FixedRoomRect,
  FixedRoomRooftop,
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

// The shared block sandbox (D-060). The Shell supplies the channel; the World
// never imports the lobby.
export {
  EMPTY_SANDBOX_SNAPSHOT,
  isSandboxTile,
  normalizeSandboxSnapshot,
  normalizeSandboxTile,
} from './sandbox-channel.js';
export type { SandboxChannel } from './sandbox-channel.js';

// The football pitch (D-078): the Shell supplies the channel, as for the
// sandbox, and the World never imports the lobby or moves the ball.
export { normalizeFootballFrame, normalizeFootballMoment } from './football-channel.js';
export type { FootballChannel, FootballFrame, FootballMoment } from './football-channel.js';
export {
  PITCH_FIXTURES,
  PITCH_FULL_TIME_TEXT,
  PITCH_GATE,
  PITCH_GATE_TEXT,
  PITCH_GOAL_TEXT,
  PITCH_KICK_PROMPT,
  pitchScoreText,
  pitchWinnerText,
  withinKickRange,
} from './map/pitch.js';
export type { PitchFixture, PitchFixtureKind } from './map/pitch.js';

// The Privacy Plaza (D-076): its tile layout and its two street stations,
// used with E. No money and no route: the Shell maps the station ids to its
// client-only windows.
export {
  PLAZA_AREA,
  PLAZA_FIXTURES,
  PLAZA_MONUMENT_STATION,
  PLAZA_NEARBY,
  PLAZA_SHELLS_STATION,
  PLAZA_SIGN_TEXT,
  PLAZA_STATIONS,
  isPlazaNearby,
  plazaStationAtApproach,
} from './map/plaza.js';
export type { PlazaFacing, PlazaFixture, PlazaFixtureKind, PlazaRect, PlazaStation } from './map/plaza.js';
export {
  EMPTY_PLAZA_STATS,
  createPlazaController,
  normalizePlazaStats,
} from './plaza-stations.js';
export type { PlazaController, PlazaControllerOptions, PlazaState, PlazaStatsPresentation } from './plaza-stations.js';
