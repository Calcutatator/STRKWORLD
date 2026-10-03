import type {
  AvatarSpriteKey,
  BuildingId,
  EventBus,
  Facing,
  SandboxColumn,
  SandboxSnapshot,
  SandboxTile,
  ShellEvents,
  WorldEvents,
} from '@strkworld/shared';
import {
  ARENA_BUILDING,
  ARENA_SPAWN_FACING,
  SANDBOX_STEP_HEIGHT,
  arenaTileAt,
  arenaTileCentre,
  presenceAreaOfBuilding,
} from '@strkworld/shared';
import {
  AVATAR_STUDIO_RETURN_FACING,
  avatarStudioReturnTile,
  createStreetMap,
  isAvatarStudioEntrance,
  isSolidAt,
  TILE_SIZE,
  tileToWorld,
  worldToTile,
  type DistrictMap,
} from './map/street.js';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_PROMPT,
  studioFigureTargetId,
  AVATAR_STUDIO_HEIGHT,
  AVATAR_STUDIO_TILE_SIZE,
  AVATAR_STUDIO_WIDTH,
  avatarStudioSpawnToWorld,
  createAvatarStudioController,
  createAvatarStudioPresentation,
  isAvatarStudioSolidAt,
  type AvatarStudioBounds,
  type AvatarStudioController,
  type AvatarStudioPresentation,
} from './avatar-studio.js';
import {
  createAvatarOutfitSelection,
  createAvatarOutfitToggleBinding,
  type AvatarOutfitSelection,
  type AvatarOutfitToggleBinding,
} from './avatar-outfit.js';
import { DEFAULT_AVATAR_SPRITE, pairedAvatarSprite } from './avatar-state.js';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';
import {
  createDoorTrigger,
  createReentryHold,
  DOOR_REENTRY_HOLD_MS,
  type DoorTrigger,
  type ReentryHold,
} from './door-trigger.js';
import {
  FIXED_ROOM_LEVELS,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomController,
  createFixedRoomLevel,
  createFixedRoomPresentation,
  fixedRoomDefinitionsFor,
  fixedRoomStationPresentations,
  isFixedRoomSolidAt,
  type FixedRoomController,
  type FixedRoomDefinition,
  type FixedRoomLevelId,
  type FixedRoomLevelMap,
  type FixedRoomStationPresentation,
} from './fixed-room.js';
import { createInputGate, type InputGate, type KeyboardLike } from './input-gate.js';
import {
  createInteractionSystem,
  type InteractionAction,
  type InteractionPrompt,
  type InteractionSource,
  type InteractionSystem,
  type InteractionTarget,
} from './interaction.js';
import { isEditableTarget } from './dom-keyboard.js';
import { plazaStations } from './map/plaza.js';
import {
  createPlazaController,
  type PlazaController,
  type PlazaStatsPresentation,
} from './plaza-stations.js';
import { calculateMovementVelocity } from './movement-input.js';
import {
  createStreetMovementAdapter,
  moveWithCollisionSubsteps,
  resolveMovementFacing,
  type MovementInput,
  type MovementVelocity,
  type StreetMovementAdapter,
} from './street-movement.js';
import { ROOM_ORIGIN, worldToRoomTile } from './world-layout.js';
import {
  EMPTY_SANDBOX_SNAPSHOT,
  normalizeSandboxSnapshot,
  normalizeSandboxTile,
  type SandboxChannel,
} from './sandbox-channel.js';
import {
  FLAT_SANDBOX,
  bodyNearSandbox,
  createSandboxHeights,
  levelUnderBody,
  sandboxAim,
  stepOnHeightmap,
  type SandboxAim,
  type SandboxHeights,
} from './sandbox.js';
import {
  normalizeFootballFrame,
  normalizeFootballMoment,
  type FootballChannel,
  type FootballFrame,
  type FootballMoment,
} from './football-channel.js';
import { withinKickRange } from './map/pitch.js';
import { createJumpState, type JumpPhase, type JumpState } from './jump.js';
import type { RemotePeerSource, RemotePeerSnapshot } from './remote-peer.js';
import {
  STREET_BENCHES,
  benchTargets,
  roomBenches,
  streetSeatIdAt,
  type WorldBench,
  type WorldSeat,
} from './seats.js';
import { ARENA_PIT_RETURN, ARENA_PIT_RETURN_FACING } from './map/arena-pit.js';
import type { ArenaChannel, ArenaSession, ArenaSessionHost, ArenaViewFrame } from './arena-channel.js';
import { createArenaSession } from './arena-session.js';

/**
 * The World's gameplay session, independent of any renderer (D-059).
 *
 * This is the orchestration the Phaser StreetScene used to own: it wires the
 * door trigger, fixed rooms, Avatar Studio, outfit selection, movement
 * reporter and input gate together, moves the player through tile-authored
 * collision, and hands every visible consequence to a `WorldSessionView`.
 * The rollback rules are carried over unchanged — each one exists because a
 * synchronous Shell handoff can fail, or re-enter, partway through a
 * transition. The renderer draws; it decides nothing.
 *
 * No network I/O happens here. Presence joins stay Shell-driven, so a second
 * session under a mounting regression cannot create a second lobby entry.
 */

export interface WorldSessionConfig {
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  readonly in?: Pick<EventBus<ShellEvents>, 'on'>;
}

/** A World pixel rectangle. */
export interface WorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlayerMotion {
  /** Intended World-pixel velocity this frame; zero when no direction is held. */
  readonly vx: number;
  readonly vy: number;
  readonly sprinting: boolean;
}

/**
 * Everything the session asks of a renderer. Implementations must be
 * synchronous: the transition sequencers call these in order and roll back
 * when one throws.
 */
export interface WorldSessionView {
  /** `snap` marks a teleport (spawn, room or Studio handoff), not a step. */
  setPlayerPosition(position: { readonly x: number; readonly y: number }, snap: boolean): void;
  setPlayerMotion(motion: PlayerMotion): void;
  setPlayerAvatar(sprite: AvatarSpriteKey): void;
  setStreetVisible(visible: boolean): void;
  setDoorsVisible(visible: boolean): void;
  setLabelsVisible(visible: boolean): void;
  setRemoteVisible(visible: boolean): void;
  /**
   * Show one fixed room's interior, or none. `level` names an upper floor's
   * interior (the Exchange's Degen floor); absent, the ground floor's.
   */
  showRoom(building: BuildingId | null, level?: FixedRoomLevelId): void;
  /** Stations of the floor the player is on; a view ignores ids it does not draw. */
  renderRoom(building: BuildingId, stations: readonly FixedRoomStationPresentation[]): void;
  /**
   * The player is on this building's roof, which is part of the street
   * scene, or on none. A view points its camera down from up there.
   */
  showRooftop?(building: BuildingId | null): void;
  syncStudio(state: { readonly visible: boolean; readonly highlightedFigure: number | null }): void;
  destroyStudio(): void;
  setCameraBounds(bounds: WorldRect): void;
  /** Session teardown: release session-owned presentation. */
  destroy?(): void;
  // Block sandbox (D-060). Optional: a view without a sandbox ignores them.
  /** Blocks under the local player's feet; changes step up or drop down. */
  setPlayerElevation?(level: number): void;
  setSandboxColumns?(columns: readonly SandboxColumn[]): void;
  /** The next block on this tile falls from the sky. */
  sandboxDrop?(tile: SandboxTile): void;
  /** D-071: every block bursts away from this tile. */
  sandboxBurst?(tile: SandboxTile): void;
  setCarried?(colour: number | null): void;
  /** Where `E` would act, or null outside the sandbox. */
  setSandboxAim?(aim: SandboxAim | null): void;
  // D-117: the one "E · …" prompt every station shares. Optional: a view
  // without it draws no prompt (E still works).
  /** Show the prompt over what E would use, or hide it. */
  setInteractionPrompt?(prompt: InteractionPrompt | null): void;
  // The Privacy Plaza (D-076). Optional: a view without the plaza ignores them.
  /** The monument's pre-formatted figures; a null part is drawn as "…". */
  setPlazaStats?(stats: PlazaStatsPresentation): void;
  // The football pitch (D-078). Optional: a view without the pitch ignores them.
  /** The ball to draw this frame and the scoreboard, or no ball. */
  setFootball?(frame: FootballFrame | null): void;
  /** Show "E · KICK" over the ball: the player is close enough to kick it. */
  setKickPrompt?(visible: boolean): void;
  /** A goal or full time: the pitch celebrates it. */
  footballMoment?(moment: FootballMoment): void;
  // The jump (D-097). Optional: a view without it simply does not jump.
  /** The local avatar takes off: play one cosmetic jump from where it stands. */
  playerJump?(): void;
  // The gladiator pit's arena (D-114). Optional: a view without it draws no ring.
  /** The ring as the arena session sees it this frame (gate, dummy, swings), or none. */
  syncArena?(frame: ArenaViewFrame | null): void;
  /** The arena prompt over the local avatar ("E · ENTER THE RING", "IN USE"), or none. */
  setArenaPrompt?(text: string | null): void;
  /** The local avatar swings once, at once (cosmetic prediction). */
  playerSwing?(): void;
  /** Turn the local avatar to a facing at once (a leap's landing, a street return). */
  setPlayerFacing?(facing: Facing): void;
  // D-127: sittable benches. Optional: a view without it simply never shows
  // the seated pose, and sitting is then only a place and a facing.
  /** The local avatar sits down on a bench, or stands up. */
  setPlayerSeated?(seated: boolean): void;
  /** The ring gate's mesh in the arena room, for the gate station's press-E cues; null if none. */
  arenaGateObject?(): unknown;
}

/** The World's one-shot action keys. */
export type WorldActionKey = 'keydown-F' | 'keydown-E' | 'keydown-Space' | 'pointerdown-primary';

interface OutfitKeyEvent {
  readonly repeat: boolean;
  readonly target: unknown;
}

/**
 * The keyboard a session reads. It is the input gate's `KeyboardLike` plus
 * held movement state and the outfit toggle's `keydown-F` emitter.
 */
export interface WorldKeyboard extends KeyboardLike {
  /** Arrows merged with WASD. Must read all-false while `enabled` is false. */
  readonly held: MovementInput;
  readonly sprinting: boolean;
  /**
   * `keydown-F` toggles the outfit (D-053); `keydown-E` is interact (D-117):
   * it uses the station the player stands at (a plaza station, a counter, a
   * Studio figure, the bunker's lift), or else picks or places a block
   * (D-060), kicks the ball (D-078) or acts in the arena's ring (D-114);
   * `keydown-Space` jumps (D-097); `pointerdown-primary`, a primary click or
   * tap on the World's canvas, strikes in the arena (D-114).
   */
  on(event: WorldActionKey, handler: (event: OutfitKeyEvent) => void): unknown;
  off(event: WorldActionKey, handler: (event: OutfitKeyEvent) => void): unknown;
}

export interface WorldSessionOptions {
  /** Absent in headless boots: every emit is then a no-op. */
  readonly config?: WorldSessionConfig;
  readonly view: WorldSessionView;
  readonly keyboard?: WorldKeyboard;
  /** Called when the player's street tile changes. It reports; it decides nothing. */
  readonly onTileChanged?: (tile: { x: number; y: number }) => void;
  /** The shared block sandbox (D-060); absent means no sandbox interaction. */
  readonly sandbox?: SandboxChannel;
  /** The shared football (D-078); absent means no ball is drawn or kicked. */
  readonly football?: FootballChannel;
  /**
   * The gladiator pit's ring (D-114); absent means the arena is a room to
   * walk round and watch from, with no ring to claim.
   */
  readonly arena?: ArenaChannel;
  /** `prefers-reduced-motion`: arena leaps become cuts (D-114). Absent reads as false. */
  readonly reducedMotion?: () => boolean;
  /**
   * The Vault opens on shadow accounts, behind the Shell's switch (D-077): its
   * door opens onto its room. Absent or false, it is D-007's locked facade.
   */
  readonly vaultOpen?: boolean;
  /**
   * Leaderboard phase 1: the placement stand east of the plaza, used with E
   * like the plaza's other stations. Absent or false, it does not exist.
   */
  readonly placementStand?: boolean;
  /**
   * D-127: the nearby players, so a bench seat another player holds is never
   * offered. Absent, every street seat looks free — the lobby still refuses a
   * shared one, and the player simply stands on it.
   */
  readonly peers?: RemotePeerSource;
}

export interface WorldFrame {
  /**
   * Camera orbit angle in radians; 0 is north-up. Movement keys are relative
   * to the camera, so the reported facing is derived from the world-space
   * direction rather than from the keys themselves.
   */
  readonly cameraYaw?: number;
}

export type WorldSessionArea = 'street' | 'studio' | BuildingId;

export interface WorldSession {
  readonly destroyed: boolean;
  /** Local player in World pixels. */
  readonly player: { readonly x: number; readonly y: number };
  readonly area: WorldSessionArea;
  /** Wire facing last published with `player:moved`. */
  readonly facing: Facing;
  /**
   * Which floor of `area` the player is on: 'ground' through the street door,
   * the Exchange tower's 'degen' and 'roof' by lift; null on the street and
   * in the Studio. The Shell still sees one building on every floor.
   */
  readonly level: FixedRoomLevelId | null;
  /** True while a panel or Shell control claim owns the keyboard. */
  readonly inputSuspended: boolean;
  /**
   * Height of the local player's feet above the street: the sandbox blocks
   * under them (D-060), or a roof; 0 anywhere else.
   */
  readonly elevation: number;
  /** D-097: the local avatar's cosmetic jump: ready, in the air, or cooling down. */
  readonly jump: JumpPhase;
  /** D-117: the "E · …" prompt showing now, or none. */
  readonly interactionPrompt: InteractionPrompt | null;
  /**
   * D-127: the bench seat the player sits on, or null standing. `index` is its
   * place in `STREET_SEATS` on the street, and -1 in a solo room.
   */
  readonly seat: WorldSeat | null;
  /**
   * D-117: the interaction system's extension points: register a station
   * kind (`register`), a non-station use of E (`addAction`, e.g. a ring
   * attack), or hold E away from every station during a fight (`suspend`).
   */
  readonly interactions: WorldInteractions;
  update(deltaMs: number, frame?: WorldFrame): void;
  /**
   * D-117: E, or the touch button: use what the prompt shows, or else the
   * sandbox, the kick or another action. Nothing while a panel or a Shell
   * claim owns the keyboard. Returns whether anything took the press.
   */
  interact(): boolean;
  destroy(): void;
}

/** D-117: what a session exposes of its interaction system. */
export type WorldInteractions = Pick<InteractionSystem, 'register' | 'addAction' | 'suspend' | 'suspended'>;

/** Longest frame the session will integrate; a stalled tab must not warp the player. */
export const MAX_SESSION_FRAME_MS = 100;

const NO_MOVEMENT: MovementInput = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
});

const IDLE_MOTION: PlayerMotion = Object.freeze({ vx: 0, vy: 0, sprinting: false });

/** D-127: no peer is sitting anywhere. Shared, so an empty snapshot allocates nothing. */
const EMPTY_SEAT_INDICES: ReadonlySet<number> = Object.freeze(new Set<number>()) as ReadonlySet<number>;
/** D-127: no bench seat is taken. */
const NO_TAKEN_SEATS: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;
/** The Studio's entrance is one zone, so the hold needs one identity (D-125). */
const AVATAR_STUDIO_ENTRANCE_HOLD_KEY = 'avatar-studio';

/** A destroyed session has no outfit to change; keep the field non-optional. */
const NOOP_AVATAR_OUTFIT: AvatarOutfitSelection = {
  get selected() {
    return DEFAULT_AVATAR_SPRITE;
  },
  select: () => false,
  toggle: () => {},
};

const NOOP_INPUT_GATE: InputGate = {
  suspend: () => {},
  resume: () => {},
  get suspended() {
    return false;
  },
};

/**
 * Turn screen-relative key velocity into World-pixel velocity.
 *
 * Yaw 0 is the north-up camera, where screen axes and World axes agree. The
 * camera orbits the player; "up" always means away from the camera.
 */
export function rotateScreenVelocity(velocity: MovementVelocity, cameraYaw: number): MovementVelocity {
  if (!Number.isFinite(cameraYaw) || cameraYaw === 0) return velocity;
  const cos = Math.cos(cameraYaw);
  const sin = Math.sin(cameraYaw);
  return {
    x: velocity.x * cos + velocity.y * sin,
    y: -velocity.x * sin + velocity.y * cos,
  };
}

/**
 * The single cardinal direction a World velocity reads as on the wire.
 *
 * The presence contract carries four facings and the reporter derives facing
 * from held directions, so it receives one synthetic direction built from the
 * intended movement. Exact diagonals resolve vertically, matching
 * `resolveMovementFacing`; no movement keeps the last facing.
 */
export function cardinalMovementInput(velocity: MovementVelocity): MovementInput {
  const { x, y } = velocity;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return NO_MOVEMENT;
  if (Math.abs(y) >= Math.abs(x)) {
    return { left: false, right: false, up: y < 0, down: y > 0 };
  }
  return { left: x < 0, right: x > 0, up: false, down: false };
}


export function createWorldSession(options: WorldSessionOptions): WorldSession {
  return new Session(options);
}

class Session implements WorldSession {
  private readonly view: WorldSessionView;
  private readonly keyboard?: WorldKeyboard;
  private readonly config?: WorldSessionConfig;
  private readonly onTileChanged?: (tile: { x: number; y: number }) => void;
  private map!: DistrictMap;
  private position = { x: 0, y: 0 };
  private bounds: WorldRect = { x: 0, y: 0, width: 0, height: 0 };
  private renderedAvatarSprite: AvatarSpriteKey = DEFAULT_AVATAR_SPRITE;
  private avatarVisualRevision = 0;
  private lastTile = { x: -1, y: -1 };
  private doors?: DoorTrigger;
  private inputGate: InputGate = NOOP_INPUT_GATE;
  private roomControllers: Partial<Record<BuildingId, FixedRoomController>> = {};
  /** Every floor's grid, by building: the ground floor and any reached by lift. */
  private roomMaps: Partial<Record<BuildingId, ReadonlyMap<FixedRoomLevelId, FixedRoomLevelMap>>> = {};
  private activeRoom?: BuildingId;
  /** The roof the view was last told the player stands on. */
  private rooftopShown: BuildingId | null = null;
  /** D-087: whether the Shell was last told the player is on the roof, a shared presence area. */
  private rooftopAnnounced = false;
  /** D-087: the facing last published with `area:moved`. */
  private areaFacing: Facing = 'down';
  private avatarStudio?: AvatarStudioController;
  private avatarStudioPresentation?: AvatarStudioPresentation;
  private avatarOutfit: AvatarOutfitSelection = NOOP_AVATAR_OUTFIT;
  private avatarOutfitToggle?: AvatarOutfitToggleBinding;
  private avatarStudioActive = false;
  /**
   * D-125: the Studio's exit leaves the player on the street tile touching its
   * hidden entrance, so that entrance takes the doors' re-entry hold
   * (door-trigger.ts): a key held through the handoff cannot walk them
   * straight back in, and the entrance stays shut until they step off it.
   */
  private readonly studioEntranceHold: ReentryHold<string> = createReentryHold();
  private movement!: StreetMovementAdapter;
  private returnTile = { x: 0, y: 0 };
  private viewOwned = false;
  private cleanedUp = false;
  private readonly sandbox?: SandboxChannel;
  private sandboxSnapshot: SandboxSnapshot = EMPTY_SANDBOX_SNAPSHOT;
  private sandboxHeights: SandboxHeights = FLAT_SANDBOX;
  private stopSandbox?: () => void;
  private stopSandboxDrops?: () => void;
  private stopSandboxBursts?: () => void;
  private stopSandboxResync?: () => void;
  private elevationLevel = 0;
  private aim: SandboxAim | null = null;
  private plaza?: PlazaController;
  private readonly football?: FootballChannel;
  private stopFootballMoments?: () => void;
  /** Whether "E · KICK" shows: exactly when a kick would reach the ball. */
  private kickPrompt = false;
  /** Whether the view was last given a ball, so a missing one is cleared once. */
  private ballShown = false;
  /** D-077: the Shell opened the Vault, so its door and room exist. */
  private readonly vaultOpen: boolean;
  private readonly placementStand: boolean;
  /** D-097: one jump at a time, then a short cooldown. */
  private readonly jumpState: JumpState = createJumpState();
  private jumpKey?: (event: { readonly repeat: boolean; readonly target: unknown }) => void;
  /** D-117: every station and every other use of E, behind one key. */
  private interactionSystem: InteractionSystem = createInteractionSystem();
  private interactKey?: (event: { readonly repeat: boolean; readonly target: unknown }) => void;
  /**
   * D-117: the World-space way the player last moved; facing for the
   * interaction system. (0, 0) until they first move: not known, so it faces
   * everything.
   */
  private heading = { x: 0, y: 0 };
  /** D-114: the ring's combat session (C's arena-session.ts), only with a channel. */
  private readonly arenaChannel?: ArenaChannel;
  private arenaSession?: ArenaSession;
  /** D-114: removes the arena's use of E from the interaction system. */
  private stopArenaAction?: () => void;
  /** D-114: removes the ring gate's station (C's `gateTargets`) from the interaction system. */
  private stopArenaSource?: () => void;
  private arenaPrimary?: (event: { readonly repeat: boolean; readonly target: unknown }) => void;
  /** Whether the view was last given a ring frame, so leaving clears it once. */
  private arenaShown = false;
  /** D-114: F is locked while the player fights. */
  private outfitLocked = false;
  /** D-114: the look to put back after a fight, if the ring switched it. */
  private lookBeforeFight: AvatarSpriteKey | null = null;
  private readonly reducedMotion?: () => boolean;
  /** D-127: the nearby players, for which bench seats are taken. */
  private readonly peers?: RemotePeerSource;
  private stopPeers?: () => void;
  /** D-127: the street seat indices peers hold right now. */
  private peerSeats: ReadonlySet<number> = EMPTY_SEAT_INDICES;
  /**
   * D-127: where the player sits, the place they rose from, and the station
   * suspension that holds E for standing up again. Null while standing.
   */
  private sitting: { readonly seat: WorldSeat; readonly from: { x: number; y: number }; readonly release: () => void } | null = null;
  /** D-127: a floor's own benches, built once per floor. */
  private readonly roomBenchCache = new Map<string, readonly WorldBench[]>();

  constructor(options: WorldSessionOptions) {
    this.view = options.view;
    this.keyboard = options.keyboard;
    this.config = options.config;
    this.onTileChanged = options.onTileChanged;
    this.sandbox = options.sandbox;
    this.football = options.football;
    this.arenaChannel = options.arena;
    this.reducedMotion = options.reducedMotion;
    this.peers = options.peers;
    this.vaultOpen = options.vaultOpen === true;
    this.placementStand = options.placementStand === true;
    try {
      this.map = createStreetMap({ vaultOpen: this.vaultOpen, placementStand: this.placementStand });
      this.bounds = this.streetBounds();
      this.viewOwned = true;
      this.movement = createStreetMovementAdapter(
        { emit: (event, payload) => this.config?.out.emit(event, payload) },
        // D-127: the seat rides along on every street placement, so the Shell
        // never needs an event of its own for sitting down or standing up.
        () => this.publishedSeat(),
      );
      this.createPlayer();
      this.createInput();
      this.createInteractions();
      this.createAvatarOutfit();
      this.createFixedRooms();
      this.createAvatarStudio();
      this.createCamera();
      this.createDoorTriggers();
      this.createInteriorVisuals();
      this.createSandbox();
      this.createPlaza();
      this.createFootball();
      this.createJump();
      this.createInteractionSources();
      this.createSeats();
      this.createArena();
    } catch (error) {
      // A constructor has no later shutdown hook. Retire the partial cycle here
      // and surface the construction failure, not a secondary cleanup error.
      try {
        this.cleanShutdown();
      } catch {
        // The construction failure is the actionable public error.
      }
      throw error;
    }
  }

  get destroyed(): boolean {
    return this.cleanedUp;
  }

  get player(): { readonly x: number; readonly y: number } {
    return { x: this.position.x, y: this.position.y };
  }

  get area(): WorldSessionArea {
    if (this.avatarStudioActive) return 'studio';
    const room = this.activeRoomController();
    if (room?.state.inRoom && this.activeRoom) return this.activeRoom;
    return 'street';
  }

  get facing(): Facing {
    return this.movement?.facing ?? 'down';
  }

  get level(): FixedRoomLevelId | null {
    if (this.avatarStudioActive) return null;
    const room = this.activeRoomController();
    if (!room?.state.inRoom || !this.activeRoom) return null;
    return room.state.level ?? 'ground';
  }

  /** Blocks under the local player's feet (D-060); 0 off the sandbox. */
  get elevation(): number {
    return this.elevationLevel;
  }

  get jump(): JumpPhase {
    return this.jumpState.phase;
  }

  get interactionPrompt(): InteractionPrompt | null {
    return this.interactionSystem.focused;
  }

  get seat(): WorldSeat | null {
    return this.sitting?.seat ?? null;
  }

  get interactions(): WorldInteractions {
    const system = this.interactionSystem;
    return {
      register: (source) => system.register(source),
      addAction: (action) => system.addAction(action),
      suspend: (reason) => system.suspend(reason),
      get suspended() {
        return system.suspended;
      },
    };
  }

  interact(): boolean {
    if (this.cleanedUp || !this.worldOwnsKeys()) return false;
    return this.interactionSystem.interact();
  }

  get inputSuspended(): boolean {
    try {
      return this.inputGate.suspended === true;
    } catch {
      return true;
    }
  }

  update(deltaMs: number, frame?: WorldFrame): void {
    if (this.cleanedUp) return;
    const delta = clampFrame(deltaMs);
    // D-127: any movement key stands the player off a bench, before anything
    // reads where they are this frame.
    if (this.sitting && this.standUpRequested()) this.standUp();
    if (this.cleanedUp) return;
    this.jumpState.advance(delta);
    const cameraYaw = Number.isFinite(frame?.cameraYaw) ? (frame!.cameraYaw as number) : 0;
    const room = this.activeRoomController();
    if (this.avatarStudioActive) {
      this.moveAvatarStudioPlayer(delta, cameraYaw);
      this.refreshInteractions();
      return;
    }
    if (room?.state.inRoom) {
      if (this.sitting) this.view.setPlayerMotion(IDLE_MOTION);
      else this.moveRoomPlayer(delta, cameraYaw);
      this.movement.interiorUpdate(() => this.reportRoomTile());
      if (!this.cleanedUp) this.presentArena(delta);
      this.refreshInteractions();
      return;
    }
    if (this.arenaShown) this.clearArena();
    this.doors?.advance(delta);
    this.studioEntranceHold.advance(delta);
    // Seated: no step, no door, no aim — only the placement keeps being
    // published, so the seat claim reaches the room.
    const input = this.sitting ? this.seatedStreetFrame() : this.moveStreetPlayer(delta, cameraYaw);
    this.movement.streetUpdate({ x: this.position.x, y: this.position.y }, input, () => {
      if (this.cleanedUp) return;
      this.reportTile();
    });
    // A door may just have taken the player inside, where there is no ball.
    if (!this.cleanedUp && this.area === 'street') this.presentFootball();
    this.refreshInteractions();
  }

  destroy(): void {
    this.cleanShutdown();
  }

  // -- teardown --------------------------------------------------------------

  private cleanShutdown(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const room of Object.values(this.roomControllers)) {
      if (room) attempt(() => room.destroy());
    }
    this.roomControllers = {};
    this.roomMaps = {};
    this.activeRoom = undefined;
    this.avatarStudioActive = false;
    const avatarOutfitToggle = this.avatarOutfitToggle;
    this.avatarOutfitToggle = undefined;
    if (avatarOutfitToggle) attempt(() => avatarOutfitToggle.destroy());
    this.avatarOutfit = NOOP_AVATAR_OUTFIT;
    const avatarStudio = this.avatarStudio;
    this.avatarStudio = undefined;
    if (avatarStudio) attempt(() => avatarStudio.destroy());
    this.avatarStudioPresentation = undefined;
    const stopSandbox = this.stopSandbox;
    this.stopSandbox = undefined;
    if (stopSandbox) attempt(stopSandbox);
    const stopSandboxDrops = this.stopSandboxDrops;
    this.stopSandboxDrops = undefined;
    if (stopSandboxDrops) attempt(stopSandboxDrops);
    const stopSandboxBursts = this.stopSandboxBursts;
    this.stopSandboxBursts = undefined;
    if (stopSandboxBursts) attempt(stopSandboxBursts);
    const stopSandboxResync = this.stopSandboxResync;
    this.stopSandboxResync = undefined;
    if (stopSandboxResync) attempt(stopSandboxResync);
    const stopPeers = this.stopPeers;
    this.stopPeers = undefined;
    if (stopPeers) attempt(stopPeers);
    const sitting = this.sitting;
    this.sitting = null;
    if (sitting) attempt(sitting.release);
    this.roomBenchCache.clear();
    const plaza = this.plaza;
    this.plaza = undefined;
    if (plaza) attempt(() => plaza.destroy());
    const stopFootballMoments = this.stopFootballMoments;
    this.stopFootballMoments = undefined;
    if (stopFootballMoments) attempt(stopFootballMoments);
    const interactKey = this.interactKey;
    this.interactKey = undefined;
    if (interactKey && this.keyboard) {
      const keyboard = this.keyboard;
      attempt(() => keyboard.off('keydown-E', interactKey));
    }
    const interactions = this.interactionSystem;
    attempt(() => interactions.destroy());
    const jumpKey = this.jumpKey;
    this.jumpKey = undefined;
    if (jumpKey && this.keyboard) {
      const keyboard = this.keyboard;
      attempt(() => keyboard.off('keydown-Space', jumpKey));
    }
    this.jumpState.reset();
    const stopArenaAction = this.stopArenaAction;
    this.stopArenaAction = undefined;
    if (stopArenaAction) attempt(stopArenaAction);
    const stopArenaSource = this.stopArenaSource;
    this.stopArenaSource = undefined;
    if (stopArenaSource) attempt(stopArenaSource);
    const arenaPrimary = this.arenaPrimary;
    this.arenaPrimary = undefined;
    if (arenaPrimary && this.keyboard) {
      const keyboard = this.keyboard;
      attempt(() => keyboard.off('pointerdown-primary', arenaPrimary));
    }
    const arenaSession = this.arenaSession;
    this.arenaSession = undefined;
    if (arenaSession) attempt(() => arenaSession.destroy());
    const inputGate = this.inputGate;
    this.inputGate = NOOP_INPUT_GATE;
    attempt(() => inputGate.resume());
    if (this.viewOwned) {
      this.viewOwned = false;
      const view = this.view;
      if (typeof view.destroy === 'function') attempt(() => view.destroy!());
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'WorldSession cleanup failed');
  }

  // -- construction ----------------------------------------------------------

  private createPlayer(): void {
    const spawn = tileToWorld(this.map.spawn.x, this.map.spawn.y);
    this.position = { x: spawn.x, y: spawn.y };
    this.view.setPlayerAvatar(DEFAULT_AVATAR_SPRITE);
    this.renderedAvatarSprite = DEFAULT_AVATAR_SPRITE;
    this.avatarVisualRevision = 0;
    this.view.setPlayerPosition(this.position, true);
    this.movement.initial({ x: this.position.x, y: this.position.y });
  }

  private createInput(): void {
    this.inputGate = this.keyboard ? createInputGate(this.keyboard) : NOOP_INPUT_GATE;
  }

  /**
   * D-117: one interaction system and one E binding for the whole session.
   * Stations (the plaza, every room counter, the Studio's figures, the
   * bunker's lift) register as sources once everything exists
   * (`createInteractionSources`); the sandbox and the kick register as
   * actions where they are built. A press aimed at a text field is never
   * read (the keyboard already drops it; this is the second lock), and
   * nothing is used while a panel or a Shell claim owns the keyboard.
   */
  private createInteractions(): void {
    this.interactionSystem = createInteractionSystem({
      onPrompt: (prompt) => this.view.setInteractionPrompt?.(prompt),
      blocked: () => this.cleanedUp || !this.worldOwnsKeys(),
    });
    const keyboard = this.keyboard;
    if (!keyboard) return;
    const onKey = (event: { readonly repeat: boolean; readonly target: unknown }): void => {
      if (this.cleanedUp || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      this.interact();
    };
    keyboard.on('keydown-E', onKey);
    this.interactKey = onKey;
  }

  /**
   * Whether the World owns the keys right now: no panel or Shell claim on
   * the gate, and no room counter holding the controls ('shell').
   */
  private worldOwnsKeys(): boolean {
    if (this.inputSuspended) return false;
    const room = this.activeRoomController();
    if (room?.state.inRoom && room.state.controlOwner !== 'world') return false;
    return true;
  }

  /** D-117: every station kind, as interaction sources. */
  private createInteractionSources(): void {
    this.interactionSystem.register(this.plazaInteractions());
    this.interactionSystem.register(this.roomInteractions());
    this.interactionSystem.register(this.studioInteractions());
  }

  /** The plaza's monument and table (D-076), from the street. */
  private plazaInteractions(): InteractionSource {
    return {
      targets: () => {
        const plaza = this.plaza;
        if (!plaza || this.area !== 'street') return [];
        const id = plaza.state.highlightedStation;
        // The monument and the table, and the placement stand when the Shell stands it.
        const station = plazaStations({ placementStand: this.placementStand }).find((candidate) => candidate.station === id);
        if (!station) return [];
        return [{
          id: station.station,
          label: station.label,
          rect: {
            x: station.x * TILE_SIZE,
            y: station.y * TILE_SIZE,
            width: station.width * TILE_SIZE,
            height: station.height * TILE_SIZE,
          },
          activate: () => this.plaza?.activate(),
        }];
      },
    };
  }

  /** The counter the player stands at on any floor of any room (D-033), and the bunker's lift (D-107). */
  private roomInteractions(): InteractionSource {
    return {
      targets: () => {
        if (this.avatarStudioActive) return [];
        const controller = this.activeRoomController();
        const map = this.activeRoomMap();
        if (!controller?.state.inRoom || !map) return [];
        const usable = controller.interaction();
        if (!usable) return [];
        const origin = floorOrigin(map);
        return [{
          id: usable.station,
          label: usable.label,
          rect: {
            x: origin.x + usable.rect.x * FIXED_ROOM_TILE_SIZE,
            y: origin.y + usable.rect.y * FIXED_ROOM_TILE_SIZE,
            width: usable.rect.width * FIXED_ROOM_TILE_SIZE,
            height: usable.rect.height * FIXED_ROOM_TILE_SIZE,
          },
          activate: () => controller.activate(),
        }];
      },
    };
  }

  /** The Avatar Studio's figures (D-053): E puts on the look in reach. */
  private studioInteractions(): InteractionSource {
    return {
      targets: () => {
        const studio = this.avatarStudio;
        if (!studio || !this.avatarStudioActive) return [];
        const usable = studio.interaction();
        if (!usable) return [];
        return [{
          id: studioFigureTargetId(usable.figure),
          label: AVATAR_STUDIO_PROMPT,
          rect: {
            x: ROOM_ORIGIN.x + usable.rect.x * AVATAR_STUDIO_TILE_SIZE,
            y: ROOM_ORIGIN.y + usable.rect.y * AVATAR_STUDIO_TILE_SIZE,
            width: usable.rect.width * AVATAR_STUDIO_TILE_SIZE,
            height: usable.rect.height * AVATAR_STUDIO_TILE_SIZE,
          },
          activate: () => studio.activate(),
        }];
      },
    };
  }

  /** Re-pick what E would use, from where the player stands and faces now. */
  private refreshInteractions(): void {
    if (this.cleanedUp) return;
    this.interactionSystem.update({ position: this.position, heading: this.heading });
  }

  /**
   * One outfit selection and one F binding for the whole session (D-053).
   *
   * Both exist before the rooms and the Studio because they share the
   * selection. If a room or the Studio owned its own binding, the toggle would
   * work only wherever that owner happened to be active.
   */
  private createAvatarOutfit(): void {
    this.avatarOutfitToggle?.destroy();
    this.avatarOutfitToggle = undefined;
    this.avatarOutfit = createAvatarOutfitSelection({
      out: {
        emit: (event, payload) => {
          if (event === 'avatar:selected') {
            const sprite = (payload as WorldEvents['avatar:selected']).sprite;
            const previousSprite = this.renderedAvatarSprite;
            const previousRevision = this.avatarVisualRevision;
            try {
              this.applyAvatarSprite(sprite);
              this.config?.out.emit(event, payload);
            } catch (error) {
              // Selection rolls back its logical state when Shell delivery
              // fails. Keep the visual in that same transaction, but do not
              // undo a newer reentrant selection made by the Shell.
              if (
                this.avatarVisualRevision === previousRevision + 1 &&
                this.renderedAvatarSprite === sprite
              ) {
                try {
                  this.applyAvatarSprite(previousSprite);
                } catch {
                  // Preserve the original Shell or visual error.
                }
              }
              throw error;
            }
            return;
          }
          this.config?.out.emit(event, payload);
        },
      },
    });
    const keyboard = this.keyboard;
    if (!keyboard) return;
    this.avatarOutfitToggle = createAvatarOutfitToggleBinding({
      keyboard,
      // Playable wherever the avatar is. The one thing that silences F is the
      // gate: a panel or Shell control claim owns the keyboard, and stealing a
      // keystroke back from a focused input is the bug input-gate.ts prevents.
      // The ring locks it while the player fights (D-114).
      isActive: () => this.inputGate?.suspended !== true && !this.outfitLocked,
      toggle: () => this.avatarOutfit.toggle(),
    });
  }

  private createFixedRooms(): void {
    this.roomMaps = {};
    this.roomControllers = {};
    const config = this.config;
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => config?.out.emit(event, payload),
    };
    // The Vault's room exists only when the Shell opened its door (D-077).
    for (const definition of fixedRoomDefinitionsFor({ vaultOpen: this.vaultOpen })) {
      const building = definition.building;
      const levels = FIXED_ROOM_LEVELS[building] ?? [];
      const floors = new Map<FixedRoomLevelId, FixedRoomLevelMap>([['ground', createFixedRoom(definition)]]);
      for (const level of levels) floors.set(level.level, createFixedRoomLevel(level));
      this.roomMaps[building] = floors;
      this.roomControllers[building] = createFixedRoomController({
        definition,
        levels,
        out,
        in: config?.in,
        input: this.inputGate,
        onEnter: () => this.enterRoom(definition),
        onExit: () => this.exitRoom(definition),
        onLevel: (level, tile) => this.presentLevel(definition, level, tile),
        onChange: () => this.renderRoom(),
      });
    }
  }

  private createAvatarStudio(): void {
    const config = this.config;
    const streetBounds = this.streetBounds();
    const studioReturn = avatarStudioReturnTile(this.map);
    const studioBounds: AvatarStudioBounds = {
      x: ROOM_ORIGIN.x,
      y: ROOM_ORIGIN.y,
      width: AVATAR_STUDIO_WIDTH * AVATAR_STUDIO_TILE_SIZE,
      height: AVATAR_STUDIO_HEIGHT * AVATAR_STUDIO_TILE_SIZE,
    };
    this.avatarStudioPresentation = createAvatarStudioPresentation({
      port: {
        setPlayerVelocity: () => this.view.setPlayerMotion(IDLE_MOTION),
        // Collision follows the active area, so there is no body to toggle.
        setBodyEnabled: () => {},
        setGroundVisible: (visible) => this.view.setStreetVisible(visible),
        setDoorsVisible: (visible) => this.view.setDoorsVisible(visible),
        // D-087: the Studio is a shared presence area, so its peers are drawn
        // there as on the street. The lobby sends only peers in the player's
        // own area, so no street passer-by is drawn in the Studio.
        setRemoteVisible: () => this.view.setRemoteVisible(true),
        setLabelsVisible: (visible) => this.view.setLabelsVisible(visible),
        setRoomVisible: (visible) => {
          if (!visible) this.view.showRoom(null);
        },
        setStudioVisible: (visible) => {
          this.view.syncStudio({
            visible,
            highlightedFigure: visible
              ? this.avatarStudio?.state.highlightedFigure ?? null
              : null,
          });
        },
        setWorldBounds: (bounds) => {
          this.bounds = { ...bounds };
        },
        setCameraBounds: (bounds) => this.view.setCameraBounds(bounds),
        setPlayerPosition: (position) => this.teleport(position),
        resetDoors: () => this.doors?.reset(),
        // D-125: the street hears the player standing outside the Studio's
        // entrance, facing north away from it, as the view shows them.
        resumeStreet: (position, report) =>
          this.movement.exit(position, report, AVATAR_STUDIO_RETURN_FACING),
        destroyStudio: () => this.view.destroyStudio(),
      },
      streetBounds,
      studioBounds,
      studioSpawn: avatarStudioSpawnToWorld(
        AVATAR_STUDIO_DEFINITION,
        ROOM_ORIGIN,
        AVATAR_STUDIO_TILE_SIZE,
      ),
      // D-125: outside the room, on the street tile touching its entrance —
      // not the street spawn, which is rows north of it up the path.
      streetReturn: tileToWorld(studioReturn.x, studioReturn.y),
      reportStreet: () => this.reportTile(),
    });
    this.avatarStudio = createAvatarStudioController({
      out: { emit: (event, payload) => config?.out.emit(event, payload) },
      selection: this.avatarOutfit,
      onEnter: () => this.enterAvatarStudioRoom(),
      onExit: () => this.exitAvatarStudioRoom(),
      onChange: () => this.renderAvatarStudio(),
      onDestroy: () => this.avatarStudioPresentation?.destroy(),
    });
  }

  private createCamera(): void {
    this.view.setCameraBounds(this.streetBounds());
  }

  /**
   * Door triggers emit onto the World's outbound bus. No network I/O and no
   * wallet: emitting a semantic event is all that happens here.
   */
  private createDoorTriggers(): void {
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => {
        // Enter the local room before publishing the semantic event. The
        // Shell's synchronous `world:stations` response must not race a
        // controller that is still considered outside.
        if (event === 'building:entered') {
          const entered = payload as WorldEvents['building:entered'];
          const controller = this.roomControllers[entered.building];
          if (controller) {
            this.returnTile = this.roomDoorReturnTile(entered.building);
            this.activeRoom = entered.building;
            try {
              controller.enter();
            } catch (error) {
              // The controller rolls back its own room state when its
              // presentation handoff fails. Clear the session's provisional
              // room ownership too, unless a nested transition or teardown has
              // already replaced it.
              if (this.activeRoom === entered.building && !this.cleanedUp) {
                this.activeRoom = undefined;
              }
              throw error;
            }
            // D-112: a shared room (the bunker) publishes its spawn first, so
            // the Shell has a placement when `building:entered` lands and goes
            // live there instead of suspending.
            if (
              this.activeRoom === entered.building && controller.state.inRoom &&
              this.isSharedFloor(entered.building, 'ground')
            ) {
              // D-114: the arena's spawn has its own facing (east, into it).
              this.areaFacing = entered.building === ARENA_BUILDING ? ARENA_SPAWN_FACING : this.movement.facing;
              this.publishAreaPosition();
              if (this.cleanedUp || this.activeRoom !== entered.building) return;
            }
          }
        } else if (event === 'building:exited') {
          this.inputGate.resume();
        }
        this.config?.out.emit(event, payload);
      },
    };
    this.doors = createDoorTrigger(this.map, out);
  }

  private createInteriorVisuals(): void {
    this.view.showRoom(null);
    this.view.syncStudio({ visible: false, highlightedFigure: null });
  }

  // -- transitions -------------------------------------------------------------

  private enterRoom(definition: FixedRoomDefinition): void {
    this.fixedRoomPresentation(definition).enter();
    this.lastTile = { x: -1, y: -1 };
    this.renderRoom();
    // D-114: through the pit's west arch you drop into the arena's west
    // tunnel with a leap, still facing east into the arena; under reduced
    // motion it is a plain handoff.
    if (definition.building === ARENA_BUILDING) {
      this.view.setPlayerFacing?.(ARENA_SPAWN_FACING);
      if (!this.prefersReducedMotion()) this.view.playerJump?.();
    }
  }

  private exitRoom(definition: FixedRoomDefinition): void {
    this.fixedRoomPresentation(definition).exit();
    this.lastTile = { x: -1, y: -1 };
    this.activeRoom = undefined;
    // D-114: back on the pit's branch path, facing west, away from the arch.
    if (definition.building === ARENA_BUILDING) {
      this.clearArena();
      this.view.setPlayerFacing?.(ARENA_PIT_RETURN_FACING);
    }
  }

  /**
   * One floor of the active building, with the player on `tile`: a lift
   * ride's arrival, or the rollback of a ride or exit that failed. An
   * interior floor is drawn over the hidden street like any room; a roof is
   * the building's real top in the street scene, so the street, its doors,
   * signs and passers-by stay drawn below and the player stands at the
   * roof's height. Nothing is emitted: the Shell still sees one building.
   */
  private presentLevel(
    definition: FixedRoomDefinition,
    level: FixedRoomLevelId,
    tile: { readonly x: number; readonly y: number },
  ): void {
    const building = definition.building;
    const map = this.roomMaps[building]?.get(level);
    if (!map) return;
    const onRoof = map.rooftop !== null;
    const area = floorBounds(map);
    this.view.setPlayerMotion(IDLE_MOTION);
    this.view.setStreetVisible(onRoof);
    this.view.setDoorsVisible(onRoof);
    this.view.setRemoteVisible(onRoof || this.isSharedFloor(building, level));
    this.view.setLabelsVisible(onRoof);
    if (onRoof) this.view.showRoom(null);
    else if (level === 'ground') this.view.showRoom(building);
    else this.view.showRoom(building, level);
    this.showRooftop(onRoof ? building : null);
    this.bounds = area;
    this.view.setCameraBounds(area);
    this.teleport(floorTileCentre(map, tile));
    if (map.rooftop) this.setElevation(map.rooftop.height);
    this.lastTile = { x: -1, y: -1 };
    this.announceRooftop(onRoof);
  }

  /**
   * D-087: tell the Shell the lift reached the roof, a shared presence area,
   * or left it. Only on a change. Arrival publishes the player's place on the
   * roof first, so the Shell has a placement when `rooftop:entered` lands.
   *
   * The flag flips before the emit and is not restored if a listener throws:
   * the floor controller then rolls the ride back through `presentLevel`,
   * which announces the way back, so the Shell is never left believing the
   * player is somewhere shared that they are not.
   */
  private announceRooftop(onRoof: boolean): void {
    if (onRoof === this.rooftopAnnounced) return;
    this.rooftopAnnounced = onRoof;
    if (onRoof) {
      this.areaFacing = this.movement.facing;
      this.publishAreaPosition();
      if (this.cleanedUp || !this.rooftopAnnounced) return;
      this.config?.out.emit('rooftop:entered', {});
    } else {
      this.config?.out.emit('rooftop:exited', {});
    }
  }

  /**
   * D-087: where the player stands in a shared area, with the facing the
   * given velocity reads as (the last one when idle). Never on the street
   * and never in a private interior: `player:moved` is the street's.
   */
  private publishAreaPosition(velocity?: MovementVelocity): void {
    if (velocity) this.areaFacing = resolveMovementFacing(cardinalMovementInput(velocity), this.areaFacing);
    this.config?.out.emit('area:moved', Object.freeze({
      position: Object.freeze({ x: this.position.x, y: this.position.y }),
      facing: this.areaFacing,
    }));
  }

  /** Tell the view about a roof only when that changes, so rooms never see the call. */
  private showRooftop(building: BuildingId | null): void {
    if (this.rooftopShown === building) return;
    this.view.showRooftop?.(building);
    this.rooftopShown = building;
  }

  private fixedRoomPresentation(definition: FixedRoomDefinition) {
    const streetPosition = tileToWorld(this.returnTile.x, this.returnTile.y);
    const roomBounds: WorldRect = {
      x: ROOM_ORIGIN.x,
      y: ROOM_ORIGIN.y,
      width: definition.width * FIXED_ROOM_TILE_SIZE,
      height: definition.height * FIXED_ROOM_TILE_SIZE,
    };
    return createFixedRoomPresentation({
      setPlayerVelocity: () => this.view.setPlayerMotion(IDLE_MOTION),
      setBodyEnabled: () => {},
      setGroundVisible: (visible) => this.view.setStreetVisible(visible),
      setDoorsVisible: (visible) => this.view.setDoorsVisible(visible),
      // D-112: a shared room's peers are drawn in it, as in the Studio. The
      // lobby sends only peers in the player's own area, so no street
      // passer-by is drawn there; a private room hides every peer.
      setRemoteVisible: (visible) =>
        this.view.setRemoteVisible(visible || this.isSharedFloor(definition.building, 'ground')),
      setLabelsVisible: (visible) => this.view.setLabelsVisible(visible),
      setRoomVisible: (visible) => {
        this.view.showRoom(visible ? definition.building : null);
        if (!visible) {
          // Released from the roof (D-087): it stops being shared before the
          // street placement and `building:exited` follow.
          this.announceRooftop(false);
          // Leaving from the roof (or undoing an entry) points the camera level again.
          this.showRooftop(null);
        }
      },
      setWorldBounds: (room) => {
        this.bounds = room ? roomBounds : this.streetBounds();
      },
      setCameraBounds: (room) => this.view.setCameraBounds(room ? roomBounds : this.streetBounds()),
      setPlayerPosition: (room) => this.teleport(
        room
          ? {
            x: ROOM_ORIGIN.x + definition.spawn.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
            y: ROOM_ORIGIN.y + definition.spawn.y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
          }
          : streetPosition,
      ),
      // A room exit holds the doors briefly (door-trigger.ts), so a key held
      // through the handoff cannot walk the player straight back in.
      resetDoors: () => this.doors?.reset({ holdMs: DOOR_REENTRY_HOLD_MS }),
      // D-114: off the arena, the street hears the player facing west, away
      // from the arch, as the view shows them.
      resumeStreet: () => this.movement.exit(
        { x: this.position.x, y: this.position.y },
        () => this.reportTile(),
        definition.building === ARENA_BUILDING ? ARENA_PIT_RETURN_FACING : undefined,
      ),
    });
  }

  private enterAvatarStudioRoom(): void {
    this.avatarStudioActive = true;
    this.activeRoom = undefined;
    this.lastTile = { x: -1, y: -1 };
    try {
      this.avatarStudioPresentation?.enter();
    } catch (error) {
      // The controller rolls back its own room state when this handoff fails.
      // Keep the mode flag aligned so a later update cannot run the player
      // through a retired Studio.
      this.avatarStudioActive = false;
      throw error;
    }
    // D-087: the Studio's placement, ahead of `avatar-studio:entered`.
    this.areaFacing = this.movement.facing;
    this.publishAreaPosition();
  }

  private exitAvatarStudioRoom(): void {
    this.avatarStudioActive = false;
    this.lastTile = { x: -1, y: -1 };
    // Before the handoff: it ends in a street tile report from the tile next
    // to the entrance, which the hold must already be guarding.
    this.studioEntranceHold.start(DOOR_REENTRY_HOLD_MS);
    try {
      this.avatarStudioPresentation?.exit();
    } catch (error) {
      // The controller restores its own room state when this handoff fails.
      // Keep the mode flag aligned with that retryable rollback unless the
      // callback already retired the session.
      if (!this.cleanedUp) this.avatarStudioActive = true;
      throw error;
    }
    // D-125: standing on the street outside the entrance, turned away from it,
    // the way the arena's return faces off its arch (D-114).
    this.view.setPlayerFacing?.(AVATAR_STUDIO_RETURN_FACING);
  }

  private renderAvatarStudio(): void {
    if (!this.avatarStudioActive) {
      this.view.syncStudio({ visible: false, highlightedFigure: null });
      return;
    }
    this.view.syncStudio({
      visible: true,
      highlightedFigure: this.avatarStudio?.state.highlightedFigure ?? null,
    });
  }

  private roomDoorReturnTile(building: BuildingId): { x: number; y: number } {
    // D-114: the tile below the pit's door is lawn beside its bowl; the
    // return is the branch path, just west of the arch.
    if (building === ARENA_BUILDING) return { x: ARENA_PIT_RETURN.x, y: ARENA_PIT_RETURN.y };
    const door = this.map.doors.find((candidate) => candidate.building === building);
    return {
      x: door?.x ?? this.map.spawn.x,
      y: (door?.y ?? this.map.spawn.y) + 1,
    };
  }

  private renderRoom(): void {
    const controller = this.activeRoomController();
    const map = this.activeRoomMap();
    if (!controller || !map || !this.activeRoom) return;
    this.view.renderRoom(this.activeRoom, fixedRoomStationPresentations(map, controller.state));
  }

  // -- per frame ---------------------------------------------------------------

  /** Street movement. Returns the synthetic direction the reporter reads facing from. */
  private moveStreetPlayer(delta: number, cameraYaw: number): MovementInput {
    const keyboard = this.keyboard;
    if (!keyboard) {
      this.view.setPlayerMotion(IDLE_MOTION);
      return NO_MOVEMENT;
    }
    const velocity = this.intendedVelocity(keyboard, cameraYaw);
    const heights = this.sandbox && bodyNearSandbox(this.position, AVATAR_BODY_SIZE / 2, TILE_SIZE)
      ? this.sandboxHeights
      : undefined;
    this.stepPlayer(velocity, delta, {
      tileSize: TILE_SIZE,
      toTile: worldToTile,
      isSolidAt: (x, y) => isSolidAt(this.map, x, y),
      heights,
      // D-106: only a jump near or past its peak steps up, once.
      climb: this.jumpState.canClimb ? SANDBOX_STEP_HEIGHT : 0,
    });
    const input = cardinalMovementInput(velocity);
    this.presentSandboxStance(input);
    return input;
  }

  private moveRoomPlayer(delta: number, cameraYaw: number): void {
    const controller = this.activeRoomController();
    const map = this.activeRoomMap();
    const keyboard = this.keyboard;
    if (!keyboard || !controller || !map || controller.state.controlOwner !== 'world') {
      this.view.setPlayerMotion(IDLE_MOTION);
      return;
    }
    const velocity = this.intendedVelocity(keyboard, cameraYaw);
    const arena = map.building === ARENA_BUILDING && map.level === 'ground';
    const moved = this.stepPlayer(velocity, delta, {
      tileSize: FIXED_ROOM_TILE_SIZE,
      toTile: (x, y) => worldToFloorTile(map, x, y),
      // D-114: the ring's interior is solid unless the arena session says
      // the local player is its fighter; the dummy never opens.
      isSolidAt: arena
        ? (x, y) => isFixedRoomSolidAt(map, x, y) && !this.ringTileOpen(x, y)
        : (x, y) => isFixedRoomSolidAt(map, x, y),
    });
    // D-087: the roof is shared, and the bunker (D-112); every other floor is private.
    if (moved && map.rooftop && this.rooftopAnnounced) this.publishAreaPosition(velocity);
    else if (moved && this.isSharedFloor(map.building, map.level)) this.publishAreaPosition(velocity);
  }

  /**
   * D-112: whether a floor is a whole shared presence area, published with
   * `area:moved` from entry to exit: the bunker's ground floor. The roof is
   * shared too, but announced on its own (`announceRooftop`).
   */
  private isSharedFloor(building: BuildingId, level: FixedRoomLevelId): boolean {
    return level === 'ground' && presenceAreaOfBuilding(building) !== null;
  }

  private moveAvatarStudioPlayer(delta: number, cameraYaw: number): void {
    const keyboard = this.keyboard;
    if (!keyboard || !this.avatarStudio?.state.inRoom) {
      this.view.setPlayerMotion(IDLE_MOTION);
      return;
    }
    const velocity = this.intendedVelocity(keyboard, cameraYaw);
    const moved = this.stepPlayer(velocity, delta, {
      tileSize: AVATAR_STUDIO_TILE_SIZE,
      toTile: worldToRoomTile,
      isSolidAt: (x, y) => isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, x, y),
    });
    if (!moved) return;
    // D-087: before the tile report, which may walk the player out.
    this.publishAreaPosition(velocity);
    if (this.cleanedUp || !this.avatarStudioActive) return;
    this.movement.interiorUpdate(() => this.reportAvatarStudioTile());
  }

  private intendedVelocity(keyboard: WorldKeyboard, cameraYaw: number): MovementVelocity {
    const sprinting = keyboard.sprinting === true;
    const screen = calculateMovementVelocity(keyboard.held ?? NO_MOVEMENT, sprinting);
    const velocity = rotateScreenVelocity(screen, cameraYaw);
    this.view.setPlayerMotion({ vx: velocity.x, vy: velocity.y, sprinting });
    return velocity;
  }

  /** One collision-swept step. Returns whether any velocity was applied. */
  private stepPlayer(
    velocity: MovementVelocity,
    delta: number,
    grid: {
      readonly tileSize: number;
      readonly toTile: (x: number, y: number) => { x: number; y: number };
      readonly isSolidAt: (x: number, y: number) => boolean;
      /** Sandbox stacks; present only near the sandbox (D-060). */
      readonly heights?: SandboxHeights;
      /** D-106: blocks this step may climb onto, once; 0 (walking) by default. */
      readonly climb?: number;
    },
  ): boolean {
    if (velocity.x === 0 && velocity.y === 0) return false;
    if (Number.isFinite(velocity.x) && Number.isFinite(velocity.y)) {
      this.heading = { x: velocity.x, y: velocity.y };
    }
    const movement = {
      position: { x: this.position.x, y: this.position.y },
      velocity,
      delta,
      tileSize: grid.tileSize,
      collisionHalfSize: AVATAR_BODY_SIZE / 2,
      toTile: grid.toTile,
      isSolidAt: grid.isSolidAt,
    };
    let next: { x: number; y: number };
    if (grid.heights) {
      const step = stepOnHeightmap({ ...movement, heights: grid.heights, climb: grid.climb ?? 0 });
      next = step.position;
      if (step.climbed) this.jumpState.climbed();
    } else {
      next = moveWithCollisionSubsteps(movement);
    }
    this.position = clampToRect(next, this.bounds);
    this.view.setPlayerPosition(this.position, false);
    return true;
  }

  private teleport(position: { readonly x: number; readonly y: number }): void {
    // D-127: a teleport is authoritative, so a seat held here is simply given
    // up rather than walked away from.
    this.clearSeat();
    this.position = { x: position.x, y: position.y };
    this.view.setPlayerPosition(this.position, true);
    // Room spawns and street return tiles are never in the sandbox, nor by the ball.
    this.setElevation(0);
    this.setAim(null);
    this.setKickPrompt(false);
    // A prompt never follows the player across a teleport; the next frame picks again.
    this.interactionSystem.clear();
  }

  // -- block sandbox (D-060) -------------------------------------------------

  private createSandbox(): void {
    const channel = this.sandbox;
    if (!channel) return;
    this.stopSandbox = channel.subscribe((snapshot) => this.applySandbox(snapshot));
    if (typeof channel.subscribeDrops === 'function') {
      this.stopSandboxDrops = channel.subscribeDrops((tile) => {
        if (this.cleanedUp) return;
        const drop = normalizeSandboxTile(tile);
        if (drop) this.view.sandboxDrop?.(drop);
      });
    }
    // A burst (D-071) only animates; the snapshot that empties the board is
    // what drops anyone standing on it, through the usual fall.
    if (typeof channel.subscribeBursts === 'function') {
      this.stopSandboxBursts = channel.subscribeBursts((tile) => {
        if (this.cleanedUp) return;
        const burst = normalizeSandboxTile(tile);
        if (burst) this.view.sandboxBurst?.(burst);
      });
    }
    if (typeof channel.subscribeResync === 'function') {
      this.stopSandboxResync = channel.subscribeResync((position) => this.resyncStreetPosition(position));
    }
    // D-117: E in the sandbox, when no station is in reach.
    const action: InteractionAction = {
      id: 'sandbox',
      run: () => {
        if (this.cleanedUp || this.area !== 'street') return false;
        const aim = this.aim;
        if (!aim || !aim.valid) return false;
        if (aim.mode === 'pick') channel.pick(aim.tile);
        else channel.place(aim.tile);
        return true;
      },
    };
    this.interactionSystem.addAction(action);
  }

  // -- the Privacy Plaza (D-076) ----------------------------------------------

  /**
   * The plaza's two stations, used with E from the street through the
   * interaction system (D-117). Built only with a bus: a headless session has
   * no Shell to open a window, so it offers no plaza station either.
   */
  private createPlaza(): void {
    const config = this.config;
    if (!config) return;
    this.plaza = createPlazaController({
      out: { emit: (event, payload) => config.out.emit(event, payload) },
      in: config.in,
      input: this.inputGate,
      onStats: (stats) => this.view.setPlazaStats?.(stats),
      stations: plazaStations({ placementStand: this.placementStand }),
    });
  }

  // -- sittable benches (D-127) -----------------------------------------------

  /**
   * Benches as an interaction source, and E again as the way back up.
   *
   * A bench is no station: it opens nothing and emits nothing semantic. It
   * borrows D-117's machinery for the chip and the gates, and opts out of
   * D-123's other cues with `cue: 'none'` (seats.ts), so standing by a bench
   * shows "[E] SIT" and nothing else lights up.
   *
   * While the player sits, the stations are suspended — the same combat yield
   * the arena uses — so nothing near the bench is focused, no chip shows, and E
   * reaches the one action registered here, which stands them up. A movement
   * key or Space does the same (`update`, `createJump`).
   */
  private createSeats(): void {
    const source = this.peers;
    if (source) {
      try {
        this.stopPeers = source.subscribe((snapshot) => this.applyPeerSeats(snapshot));
      } catch {
        // A peer source that cannot be read leaves every seat looking free;
        // the lobby still refuses a seat someone else holds.
      }
    }
    this.interactionSystem.register({ targets: () => this.seatTargets() });
    this.interactionSystem.addAction({
      id: 'seat:stand',
      // Above the arena's own use of E: a player cannot be sitting on a bench
      // and fighting in the ring, and standing up must never be out-voted.
      priority: 20,
      run: () => {
        if (this.cleanedUp || !this.sitting) return false;
        this.standUp();
        return true;
      },
    });
  }

  /** The benches in reach with a free seat: the street's, or the floor's own. */
  private seatTargets(): readonly InteractionTarget[] {
    if (this.cleanedUp || this.sitting) return [];
    if (this.avatarStudioActive) return [];
    if (this.area === 'street') {
      return benchTargets(STREET_BENCHES, this.position, this.takenSeats(), (seat) => this.sitOn(seat));
    }
    const controller = this.activeRoomController();
    const map = this.activeRoomMap();
    if (!controller?.state.inRoom || !map) return [];
    // A solo interior: only this player can be on its seats.
    return benchTargets(this.benchesOf(map), this.position, NO_TAKEN_SEATS, (seat) => this.sitOn(seat));
  }

  /** One floor's benches, built once. */
  private benchesOf(map: FixedRoomLevelMap): readonly WorldBench[] {
    const key = `${map.building}:${map.level}`;
    let benches = this.roomBenchCache.get(key);
    if (!benches) {
      benches = roomBenches(map);
      this.roomBenchCache.set(key, benches);
    }
    return benches;
  }

  /** D-127: the street seats peers hold, as seat ids. */
  private takenSeats(): ReadonlySet<string> {
    if (this.peerSeats.size === 0) return NO_TAKEN_SEATS;
    const taken = new Set<string>();
    for (const index of this.peerSeats) {
      const id = streetSeatIdAt(index);
      if (id !== null) taken.add(id);
    }
    return taken;
  }

  /**
   * Which street seats the nearby players hold. Read from the same validated
   * snapshot the figures are drawn from, so a seat only counts as taken while
   * someone the lobby reports is actually sitting on it.
   */
  private applyPeerSeats(snapshot: readonly RemotePeerSnapshot[]): void {
    if (this.cleanedUp) return;
    let next: Set<number> | null = null;
    if (Array.isArray(snapshot)) {
      for (const peer of snapshot) {
        const seat = peer?.seat;
        if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0) continue;
        (next ??= new Set<number>()).add(seat);
      }
    }
    this.peerSeats = next ?? EMPTY_SEAT_INDICES;
  }

  /**
   * Sit on `seat`: snap onto it, face out from the bench, hold the stations,
   * and publish the place (on the street, with the seat). The tile the player
   * pressed E from is kept, because the seat itself is a solid fixture: that is
   * where standing up puts them back.
   */
  private sitOn(seat: WorldSeat): void {
    if (this.cleanedUp || this.sitting) return;
    const from = { x: this.position.x, y: this.position.y };
    const release = this.interactionSystem.suspend('seated');
    this.sitting = { seat, from, release };
    try {
      this.position = { x: seat.x, y: seat.y };
      this.view.setPlayerMotion(IDLE_MOTION);
      this.view.setPlayerPosition(this.position, false);
      this.view.setPlayerFacing?.(seat.facing);
      this.view.setPlayerSeated?.(true);
      this.publishSeatedPlace(seat.facing);
    } catch (error) {
      // Sitting down is one transaction: a failed handoff puts the player back
      // on their feet where they were, so E can be pressed again.
      if (this.sitting?.seat === seat && !this.cleanedUp) {
        this.sitting = null;
        try {
          release();
        } catch {
          // Preserve the original failure.
        }
        this.position = from;
        try {
          this.view.setPlayerSeated?.(false);
          this.view.setPlayerPosition(this.position, false);
        } catch {
          // Preserve the original failure.
        }
      }
      throw error;
    }
  }

  /** Stand up: back to the place E was pressed from, stations live again. */
  private standUp(): void {
    const sitting = this.sitting;
    if (!sitting) return;
    this.sitting = null;
    const errors: unknown[] = [];
    try {
      sitting.release();
    } catch (error) {
      errors.push(error);
    }
    this.position = { x: sitting.from.x, y: sitting.from.y };
    try {
      this.view.setPlayerSeated?.(false);
      this.view.setPlayerPosition(this.position, false);
    } catch (error) {
      errors.push(error);
    }
    if (!this.cleanedUp) {
      try {
        this.publishSeatedPlace();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Standing up failed');
  }

  /**
   * Publish where the player now sits or stands. On the street that is the
   * ordinary placement (`player:moved`, which carries the seat while they sit);
   * a solo room publishes nothing at all.
   */
  private publishSeatedPlace(facing?: Facing): void {
    if (this.area !== 'street') return;
    this.movement.exit({ x: this.position.x, y: this.position.y }, () => {
      if (!this.cleanedUp) this.reportTile();
    }, facing);
  }

  /**
   * A street frame spent sitting: nothing moves, and the reporter publishes the
   * seat again, so a claim the room has not applied yet is re-sent like any
   * position.
   */
  private seatedStreetFrame(): MovementInput {
    this.view.setPlayerMotion(IDLE_MOTION);
    return NO_MOVEMENT;
  }

  /** D-127: the seat index `player:moved` carries, or -1 when standing or in a room. */
  private publishedSeat(): number {
    const seat = this.sitting?.seat;
    return seat && seat.index >= 0 ? seat.index : -1;
  }

  /**
   * Whether a held movement key should stand the player up. The keyboard reads
   * all-false while the gate is closed, so a panel never lifts them.
   */
  private standUpRequested(): boolean {
    const held = this.keyboard?.held;
    return held !== undefined && (held.left || held.right || held.up || held.down);
  }

  /**
   * Give up the seat without walking anywhere: a teleport (a room handoff, a
   * resync, a lift) has already decided where the player is.
   */
  private clearSeat(): void {
    const sitting = this.sitting;
    if (!sitting) return;
    this.sitting = null;
    try {
      sitting.release();
    } catch {
      // The teleport is authoritative; a failed release only leaves the
      // stations suspended, which the next suspension release clears.
    }
    this.view.setPlayerSeated?.(false);
  }

  // -- the jump (D-097) --------------------------------------------------------

  /**
   * Space jumps: a short cosmetic hop that never touches movement or
   * collision. It works wherever the avatar walks (D-111): the street, the
   * plaza and the sandbox, every interior and its upper floors, the roof, the
   * bunker and the Avatar Studio, with the same arc everywhere. Ignored, never
   * queued, while a panel or Shell claim owns the keyboard (the gate; the
   * keyboard also never reads a keystroke aimed at a text field) and while a
   * room's counter holds the controls ('shell'). A held key's repeats do
   * nothing, and a press in the air or in the cooldown is dropped: no double
   * jump, no buffered jump. Only the street's sandbox has a heightmap, so a
   * jump climbs nowhere else: indoors every fixture stays a wall (D-106).
   */
  private createJump(): void {
    const keyboard = this.keyboard;
    if (!keyboard) return;
    const onKey = (event: { readonly repeat: boolean; readonly target: unknown }): void => {
      if (this.cleanedUp || event.repeat) return;
      if (!this.canJump()) return;
      // D-127: Space off a bench stands the player up; it does not also jump.
      if (this.sitting) {
        this.standUp();
        return;
      }
      if (!this.jumpState.tryStart()) return;
      this.view.playerJump?.();
      if (this.cleanedUp) return;
      // The Shell decides whether anyone is told: only in a shared area.
      this.config?.out.emit('player:jumped', Object.freeze({}) as Record<string, never>);
    };
    keyboard.on('keydown-Space', onKey);
    this.jumpKey = onKey;
  }

  /**
   * Whether Space may jump right now: whenever the World owns the keyboard
   * (D-111). The Avatar Studio is no exception; its selection is by walking.
   */
  private canJump(): boolean {
    if (this.inputSuspended) return false;
    const room = this.activeRoomController();
    if (room?.state.inRoom && room.state.controlOwner !== 'world') return false;
    return true;
  }

  // -- the gladiator pit's arena (D-114) ------------------------------------------

  /**
   * The ring's combat session (C's `arena-session.ts`), with this session as
   * its host, and its two inputs: E (claim, strike; an interaction action,
   * D-117) and a primary click or tap on the canvas (strike). Both work only in the arena, only while the
   * World owns the keyboard and the room's controls; the session decides
   * whether they do anything. Built only with a channel: without one the
   * arena is a room to walk and watch from.
   */
  private createArena(): void {
    const channel = this.arenaChannel;
    if (!channel) return;
    const session: ArenaSession = createArenaSession(channel, this.arenaHost());
    this.arenaSession = session;
    // D-117: E is interact. The ring's gate is a station (C's `gateTargets`:
    // CLAIM, or IN USE), so the shared system prompts and uses it like any
    // counter; E in a fight is an action (`onAttack`), which C's session
    // makes win outright by suspending the stations while it fights. A
    // session without them (PR 0's stub) gets the press as a plain action.
    if (typeof session.gateTargets === 'function') {
      this.stopArenaSource = this.interactionSystem.register({
        targets: () => {
          if (this.cleanedUp || !this.arenaInputLive()) return [];
          return session.gateTargets?.() ?? [];
        },
      });
    }
    this.stopArenaAction = this.interactionSystem.addAction({
      id: 'arena',
      priority: 10,
      run: () => {
        if (this.cleanedUp || !this.arenaInputLive()) return false;
        try {
          return typeof session.onAttack === 'function' ? session.onAttack() === true : session.onInteract() === true;
        } catch {
          return false;
        }
      },
    });
    const keyboard = this.keyboard;
    if (!keyboard) return;
    const onPrimary = (event: { readonly repeat: boolean; readonly target: unknown }): void => {
      if (this.cleanedUp || event.repeat || !this.arenaInputLive()) return;
      this.arenaSession?.onPrimary();
    };
    keyboard.on('pointerdown-primary', onPrimary);
    this.arenaPrimary = onPrimary;
  }

  /** Whether arena input may act: in the arena, the World owning the keyboard and the room's controls. */
  private arenaInputLive(): boolean {
    if (this.inputSuspended || this.area !== ARENA_BUILDING) return false;
    return this.activeRoomController()?.state.controlOwner === 'world';
  }

  /** D-114: a ring tile the arena session opens for the local fighter. Never the dummy. */
  private ringTileOpen(x: number, y: number): boolean {
    if (arenaTileAt(x, y) !== 'ring') return false;
    try {
      return this.arenaSession?.isRingTileWalkable(x, y) === true;
    } catch {
      // A failing session opens nothing.
      return false;
    }
  }

  /** Advance the arena session and hand the view its frame, in the arena only. */
  private presentArena(delta: number): void {
    if (this.area !== ARENA_BUILDING) {
      if (this.arenaShown) this.clearArena();
      return;
    }
    const session = this.arenaSession;
    if (!session) return;
    let frame: ArenaViewFrame | null = null;
    try {
      session.update(delta);
      if (this.cleanedUp) return;
      frame = session.frame();
    } catch {
      // A failing session draws an idle ring; the arena carries on.
      frame = null;
    }
    if (frame || this.arenaShown) this.view.syncArena?.(frame);
    this.arenaShown = frame !== null;
  }

  /** Leaving the arena: no ring frame and no prompt are left on the view. */
  private clearArena(): void {
    if (this.arenaShown) this.view.syncArena?.(null);
    this.arenaShown = false;
    this.view.setArenaPrompt?.(null);
  }

  private prefersReducedMotion(): boolean {
    try {
      return this.reducedMotion?.() === true;
    } catch {
      return false;
    }
  }

  /** What the arena session may ask of the World (`ArenaSessionHost`). */
  private arenaHost(): ArenaSessionHost {
    return Object.freeze({
      // World pixels, the room origin included: the same frame as
      // `arenaTileCentre` and the lobby's held positions.
      position: () => Object.freeze({ x: this.position.x, y: this.position.y, facing: this.areaFacing }),
      leapTo: (tile: { readonly x: number; readonly y: number }, facing: Facing) => this.leapTo(tile, facing),
      setPrompt: (text: string | null) => {
        if (this.cleanedUp) return;
        this.view.setArenaPrompt?.(this.area === ARENA_BUILDING ? text : null);
      },
      playLocalSwing: () => {
        if (!this.cleanedUp && this.area === ARENA_BUILDING) this.view.playerSwing?.();
      },
      setOutfitLocked: (locked: boolean) => {
        this.outfitLocked = locked === true;
      },
      selectLook: (mode: 'fighting' | 'restore') => this.selectArenaLook(mode),
      reducedMotion: () => this.prefersReducedMotion(),
      // C's optional host members (D-117): the World not owning the keys, the
      // combat yield, and the gate's mesh for its station's cues.
      inputSuspended: () => this.cleanedUp || !this.worldOwnsKeys(),
      suspendInteractions: (reason: string) => this.interactionSystem.suspend(reason),
      gateObject: () => (this.cleanedUp ? null : this.view.arenaGateObject?.() ?? null),
    });
  }

  /**
   * D-114: the server moved the fighter (the ring spawn on a claim, the
   * return tile when the fight closes); stand there too, with a leap (a cut
   * under reduced motion), facing the way the server says, and publish the
   * new place. Arena-local tile; ignored outside the arena or off its grid.
   */
  private leapTo(tile: { readonly x: number; readonly y: number }, facing: Facing): void {
    if (this.cleanedUp || this.area !== ARENA_BUILDING) return;
    if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)) return;
    if (arenaTileAt(tile.x, tile.y) === 'void') return;
    const target = arenaTileCentre(tile);
    this.position = { x: target.x, y: target.y };
    this.view.setPlayerPosition(this.position, false);
    this.view.setPlayerFacing?.(facing);
    if (!this.prefersReducedMotion()) this.view.playerJump?.();
    if (this.cleanedUp) return;
    this.areaFacing = facing;
    this.publishAreaPosition();
    if (this.cleanedUp) return;
    this.reportRoomTile();
  }

  /** D-114: into the paired fighting look for the ring if in a cosy one; back to it after. */
  private selectArenaLook(mode: 'fighting' | 'restore'): void {
    if (this.cleanedUp) return;
    const current = this.avatarOutfit.selected;
    if (mode === 'fighting') {
      const number = Number(current.slice('avatar-'.length));
      if (!(number >= 1 && number <= 8)) return;
      this.lookBeforeFight = current;
      this.avatarOutfit.select(pairedAvatarSprite(current));
      return;
    }
    const before = this.lookBeforeFight;
    this.lookBeforeFight = null;
    if (before && before !== current) this.avatarOutfit.select(before);
  }

  // -- the football pitch (D-078) ---------------------------------------------

  /**
   * The ball, drawn where the Shell's channel says each frame, its
   * celebrations, and E to kick it while "E · KICK" shows. The World never
   * moves the ball: the authority does.
   */
  private createFootball(): void {
    const channel = this.football;
    if (!channel) return;
    if (typeof channel.subscribeMoments === 'function') {
      this.stopFootballMoments = channel.subscribeMoments((value) => {
        if (this.cleanedUp) return;
        const moment = normalizeFootballMoment(value);
        if (moment) this.view.footballMoment?.(moment);
      });
    }
    // D-117: E kicks while "E · KICK" shows, when no station is in reach.
    this.interactionSystem.addAction({
      id: 'football:kick',
      run: () => {
        if (this.cleanedUp || this.area !== 'street') return false;
        // The prompt shows exactly when a kick would reach the ball.
        if (!this.kickPrompt) return false;
        channel.kick();
        return true;
      },
    });
  }

  /** Hand the view this frame's ball, and show "E · KICK" while a kick would reach it. */
  private presentFootball(): void {
    const channel = this.football;
    if (!channel) return;
    let frame: FootballFrame | null = null;
    try {
      frame = normalizeFootballFrame(channel.frame());
    } catch {
      // A failing channel draws no ball; the street carries on.
      frame = null;
    }
    if (frame || this.ballShown) this.view.setFootball?.(frame);
    this.ballShown = frame !== null;
    this.setKickPrompt(frame !== null && frame.phase === 'live' && withinKickRange(this.position, frame, TILE_SIZE));
  }

  private setKickPrompt(visible: boolean): void {
    if (visible === this.kickPrompt) return;
    this.kickPrompt = visible;
    this.view.setKickPrompt?.(visible);
  }

  private applySandbox(value: SandboxSnapshot): void {
    if (this.cleanedUp) return;
    const previousCarrying = this.sandboxSnapshot.carrying;
    const snapshot = normalizeSandboxSnapshot(value);
    this.sandboxSnapshot = snapshot;
    this.sandboxHeights = createSandboxHeights(snapshot.columns);
    this.view.setSandboxColumns?.(snapshot.columns);
    if (snapshot.carrying !== previousCarrying) this.view.setCarried?.(snapshot.carrying);
    // Stacks can change under a player who is standing still.
    if (this.area === 'street') this.presentSandboxStance(null);
  }

  /** Elevation and aim after the player moved or the stacks changed. */
  private presentSandboxStance(input: MovementInput | null): void {
    if (!this.sandbox) return;
    const halfSize = AVATAR_BODY_SIZE / 2;
    if (!bodyNearSandbox(this.position, halfSize, TILE_SIZE)) {
      this.setElevation(0);
      this.setAim(null);
      return;
    }
    this.setElevation(levelUnderBody(this.sandboxHeights, this.position, halfSize, TILE_SIZE));
    // Aim along the facing the player just chose; an idle frame keeps it.
    const facing = input && (input.up || input.down || input.left || input.right)
      ? (input.up ? 'up' : input.down ? 'down' : input.left ? 'left' : 'right')
      : this.movement.facing;
    this.setAim(sandboxAim({
      heights: this.sandboxHeights,
      position: this.position,
      facing,
      carrying: this.sandboxSnapshot.carrying,
      halfSize,
      tileSize: TILE_SIZE,
    }));
  }

  /**
   * D-106: the lobby refused a step up (no jump it heard of, or a second climb
   * in one jump) and holds the player where it last accepted them. Stand
   * there again: a short drop back off the stack, never a teleport across the
   * map. Street only; a room or the Studio has no stacks to be refused.
   */
  private resyncStreetPosition(value: unknown): void {
    if (this.cleanedUp || this.area !== 'street') return;
    if (value === null || typeof value !== 'object') return;
    let x: unknown;
    let y: unknown;
    try {
      ({ x, y } = value as { x?: unknown; y?: unknown });
    } catch {
      return;
    }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const target = clampToRect({ x, y }, this.bounds);
    const far = Math.hypot(target.x - this.position.x, target.y - this.position.y) > 2 * TILE_SIZE;
    this.position = target;
    this.view.setPlayerPosition(this.position, far);
    // No second try in the same jump: the lobby would refuse that too.
    this.jumpState.climbed();
    this.presentSandboxStance(null);
  }

  private setElevation(level: number): void {
    if (level === this.elevationLevel) return;
    this.elevationLevel = level;
    this.view.setPlayerElevation?.(level);
  }

  private setAim(aim: SandboxAim | null): void {
    const current = this.aim;
    if (
      current === aim ||
      (current && aim &&
        current.tile.x === aim.tile.x && current.tile.y === aim.tile.y &&
        current.mode === aim.mode && current.level === aim.level && current.valid === aim.valid)
    ) {
      return;
    }
    this.aim = aim;
    this.view.setSandboxAim?.(aim);
  }

  private reportTile(): void {
    const tile = worldToTile(this.position.x, this.position.y);
    if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
    const onStudioEntrance = !this.avatarStudioActive &&
      isAvatarStudioEntrance(this.map, tile.x, tile.y);
    // D-125: every tile report feeds the hold, because stepping off the
    // entrance is what releases it. Swallowed, the tile is reported as any
    // other street tile would be: the entrance is no door, so nothing else
    // here treats it specially.
    const studioShut = this.studioEntranceHold.swallows(
      onStudioEntrance ? AVATAR_STUDIO_ENTRANCE_HOLD_KEY : null,
      this.avatarStudioActive,
    );
    if (onStudioEntrance && !studioShut) {
      this.avatarStudio?.enter();
      // Studio entry is an external lifecycle boundary. Commit the tile only
      // after the transition succeeds so a failed entry can retry while the
      // player remains on the entrance.
      if (this.cleanedUp) return;
      this.lastTile = tile;
      return;
    }
    // Keep the sentinel committed during delivery so a nested report cannot
    // re-enter the same tile. If the door handoff fails, the trigger restores
    // its own occupancy and this session must leave the tile retryable too. A
    // nested transition may already have taken over; only roll back this
    // attempt's own commit in that case.
    const previousTile = this.lastTile;
    this.lastTile = tile;
    try {
      this.doors?.update(tile);
    } catch (error) {
      if (this.lastTile === tile) this.lastTile = previousTile;
      throw error;
    }
    if (this.cleanedUp) return;
    // D-076: which plaza station E would use, and whether the plaza is in
    // view. A door may just have taken the player inside, where neither applies.
    if (this.area === 'street') {
      try {
        this.plaza?.update(tile);
      } catch (error) {
        if (!this.cleanedUp && this.lastTile === tile) this.lastTile = previousTile;
        throw error;
      }
      if (this.cleanedUp) return;
    }
    try {
      this.onTileChanged?.(tile);
    } catch (error) {
      // The tile observer is an external synchronous handoff. Keep this tile
      // retryable unless a nested report or teardown already took ownership.
      if (!this.cleanedUp && this.lastTile === tile) this.lastTile = previousTile;
      throw error;
    }
  }

  private reportAvatarStudioTile(): void {
    const tile = worldToRoomTile(this.position.x, this.position.y);
    if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
    const previousTile = this.lastTile;
    this.lastTile = tile;
    try {
      this.avatarStudio?.update(tile);
    } catch (error) {
      // Studio callbacks are synchronous and may fail at the Shell boundary.
      // Keep this tile retryable unless a nested report replaced the sentinel.
      if (this.lastTile === tile) this.lastTile = previousTile;
      throw error;
    }
  }

  private reportRoomTile(): void {
    const map = this.activeRoomMap();
    if (!map) return;
    const tile = worldToFloorTile(map, this.position.x, this.position.y);
    if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
    const previousTile = this.lastTile;
    this.lastTile = tile;
    try {
      this.activeRoomController()?.update(tile);
    } catch (error) {
      // Station activation is a synchronous Shell handoff. Keep this tile
      // retryable when delivery fails, unless a nested transition or teardown
      // already replaced the sentinel with newer ownership.
      if (!this.cleanedUp && this.lastTile === tile) this.lastTile = previousTile;
      throw error;
    }
  }

  private applyAvatarSprite(sprite: AvatarSpriteKey): void {
    this.view.setPlayerAvatar(sprite);
    this.renderedAvatarSprite = sprite;
    this.avatarVisualRevision += 1;
  }

  private activeRoomController(): FixedRoomController | undefined {
    return this.activeRoom ? this.roomControllers[this.activeRoom] : undefined;
  }

  /** The grid of the floor the player is on. */
  private activeRoomMap(): FixedRoomLevelMap | undefined {
    if (!this.activeRoom) return undefined;
    const level = this.roomControllers[this.activeRoom]?.state.level ?? 'ground';
    return this.roomMaps[this.activeRoom]?.get(level);
  }

  private streetBounds(): WorldRect {
    return {
      x: 0,
      y: 0,
      width: this.map.width * TILE_SIZE,
      height: this.map.height * TILE_SIZE,
    };
  }
}

/** A floor's area in World pixels: an interior at the room origin, a roof over its footprint. */
function floorBounds(map: FixedRoomLevelMap): WorldRect {
  const origin = floorOrigin(map);
  return {
    x: origin.x,
    y: origin.y,
    width: map.width * FIXED_ROOM_TILE_SIZE,
    height: map.height * FIXED_ROOM_TILE_SIZE,
  };
}

function floorOrigin(map: FixedRoomLevelMap): { readonly x: number; readonly y: number } {
  return map.rooftop
    ? { x: map.rooftop.x * TILE_SIZE, y: map.rooftop.y * TILE_SIZE }
    : ROOM_ORIGIN;
}

function floorTileCentre(map: FixedRoomLevelMap, tile: { readonly x: number; readonly y: number }): { x: number; y: number } {
  const origin = floorOrigin(map);
  return {
    x: origin.x + tile.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    y: origin.y + tile.y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
  };
}

/** The floor tile under a World pixel position; interiors keep `worldToRoomTile`. */
function worldToFloorTile(map: FixedRoomLevelMap, x: number, y: number): { x: number; y: number } {
  if (!map.rooftop) return worldToRoomTile(x, y);
  const origin = floorOrigin(map);
  return {
    x: Math.floor((x - origin.x) / FIXED_ROOM_TILE_SIZE),
    y: Math.floor((y - origin.y) / FIXED_ROOM_TILE_SIZE),
  };
}

function clampFrame(deltaMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
  return Math.min(deltaMs, MAX_SESSION_FRAME_MS);
}

/** Keep the player inside the active area, as a physics world bound would. */
function clampToRect(position: { x: number; y: number }, rect: WorldRect): { x: number; y: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) return position;
  return {
    x: Math.min(Math.max(position.x, rect.x), rect.x + rect.width),
    y: Math.min(Math.max(position.y, rect.y), rect.y + rect.height),
  };
}
