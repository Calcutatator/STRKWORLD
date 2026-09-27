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
import { DEFAULT_AVATAR_SPRITE } from './avatar-state.js';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';
import { createDoorTrigger, type DoorTrigger } from './door-trigger.js';
import {
  FIXED_ROOM_DEFINITIONS,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomController,
  createFixedRoomPresentation,
  fixedRoomStationPresentations,
  isFixedRoomSolidAt,
  type FixedRoomController,
  type FixedRoomDefinition,
  type FixedRoomMap,
  type FixedRoomStationPresentation,
} from './fixed-room.js';
import { createInputGate, type InputGate, type KeyboardLike } from './input-gate.js';
import { calculateMovementVelocity } from './movement-input.js';
import {
  createStreetMovementAdapter,
  moveWithCollisionSubsteps,
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
  moveOnHeightmap,
  sandboxAim,
  type SandboxAim,
  type SandboxHeights,
} from './sandbox.js';

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
  /** Show one fixed room's interior, or none. */
  showRoom(building: BuildingId | null): void;
  renderRoom(building: BuildingId, stations: readonly FixedRoomStationPresentation[]): void;
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
  setCarried?(colour: number | null): void;
  /** Where `E` would act, or null outside the sandbox. */
  setSandboxAim?(aim: SandboxAim | null): void;
}

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
  /** `keydown-F` toggles the outfit (D-053); `keydown-E` picks or places a block (D-060). */
  on(event: 'keydown-F' | 'keydown-E', handler: (event: OutfitKeyEvent) => void): unknown;
  off(event: 'keydown-F' | 'keydown-E', handler: (event: OutfitKeyEvent) => void): unknown;
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
  /** True while a panel or Shell control claim owns the keyboard. */
  readonly inputSuspended: boolean;
  /** Blocks under the local player's feet (D-060); 0 off the sandbox. */
  readonly elevation: number;
  update(deltaMs: number, frame?: WorldFrame): void;
  destroy(): void;
}

/** Longest frame the session will integrate; a stalled tab must not warp the player. */
export const MAX_SESSION_FRAME_MS = 100;

const NO_MOVEMENT: MovementInput = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
});

const IDLE_MOTION: PlayerMotion = Object.freeze({ vx: 0, vy: 0, sprinting: false });

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
  private roomMaps: Partial<Record<BuildingId, FixedRoomMap>> = {};
  private activeRoom?: BuildingId;
  private avatarStudio?: AvatarStudioController;
  private avatarStudioPresentation?: AvatarStudioPresentation;
  private avatarOutfit: AvatarOutfitSelection = NOOP_AVATAR_OUTFIT;
  private avatarOutfitToggle?: AvatarOutfitToggleBinding;
  private avatarStudioActive = false;
  private movement!: StreetMovementAdapter;
  private returnTile = { x: 0, y: 0 };
  private viewOwned = false;
  private cleanedUp = false;
  private readonly sandbox?: SandboxChannel;
  private sandboxSnapshot: SandboxSnapshot = EMPTY_SANDBOX_SNAPSHOT;
  private sandboxHeights: SandboxHeights = FLAT_SANDBOX;
  private stopSandbox?: () => void;
  private stopSandboxDrops?: () => void;
  private sandboxKey?: (event: { readonly repeat: boolean; readonly target: unknown }) => void;
  private elevationLevel = 0;
  private aim: SandboxAim | null = null;

  constructor(options: WorldSessionOptions) {
    this.view = options.view;
    this.keyboard = options.keyboard;
    this.config = options.config;
    this.onTileChanged = options.onTileChanged;
    this.sandbox = options.sandbox;
    try {
      this.map = createStreetMap();
      this.bounds = this.streetBounds();
      this.viewOwned = true;
      this.movement = createStreetMovementAdapter({
        emit: (event, payload) => this.config?.out.emit(event, payload),
      });
      this.createPlayer();
      this.createInput();
      this.createAvatarOutfit();
      this.createFixedRooms();
      this.createAvatarStudio();
      this.createCamera();
      this.createDoorTriggers();
      this.createInteriorVisuals();
      this.createSandbox();
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

  /** Blocks under the local player's feet (D-060); 0 off the sandbox. */
  get elevation(): number {
    return this.elevationLevel;
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
    const cameraYaw = Number.isFinite(frame?.cameraYaw) ? (frame!.cameraYaw as number) : 0;
    const room = this.activeRoomController();
    if (this.avatarStudioActive) {
      this.moveAvatarStudioPlayer(delta, cameraYaw);
      return;
    }
    if (room?.state.inRoom) {
      this.moveRoomPlayer(delta, cameraYaw);
      this.movement.interiorUpdate(() => this.reportRoomTile());
      return;
    }
    const input = this.moveStreetPlayer(delta, cameraYaw);
    this.movement.streetUpdate({ x: this.position.x, y: this.position.y }, input, () => {
      if (this.cleanedUp) return;
      this.reportTile();
    });
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
    const sandboxKey = this.sandboxKey;
    this.sandboxKey = undefined;
    if (sandboxKey && this.keyboard) {
      const keyboard = this.keyboard;
      attempt(() => keyboard.off('keydown-E', sandboxKey));
    }
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
      isActive: () => this.inputGate?.suspended !== true,
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
    for (const definition of Object.values(FIXED_ROOM_DEFINITIONS)) {
      const building = definition.building;
      this.roomMaps[building] = createFixedRoom(definition);
      this.roomControllers[building] = createFixedRoomController({
        definition,
        out,
        in: config?.in,
        input: this.inputGate,
        onEnter: () => this.enterRoom(definition),
        onExit: () => this.exitRoom(definition),
        onChange: () => this.renderRoom(),
      });
    }
  }

  private createAvatarStudio(): void {
    const config = this.config;
    const streetBounds = this.streetBounds();
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
        setRemoteVisible: (visible) => this.view.setRemoteVisible(visible),
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
        resumeStreet: (position, report) => this.movement.exit(position, report),
        destroyStudio: () => this.view.destroyStudio(),
      },
      streetBounds,
      studioBounds,
      studioSpawn: avatarStudioSpawnToWorld(
        AVATAR_STUDIO_DEFINITION,
        ROOM_ORIGIN,
        AVATAR_STUDIO_TILE_SIZE,
      ),
      streetReturn: tileToWorld(this.map.spawn.x, this.map.spawn.y),
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
  }

  private exitRoom(definition: FixedRoomDefinition): void {
    this.fixedRoomPresentation(definition).exit();
    this.lastTile = { x: -1, y: -1 };
    this.activeRoom = undefined;
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
      setRemoteVisible: (visible) => this.view.setRemoteVisible(visible),
      setLabelsVisible: (visible) => this.view.setLabelsVisible(visible),
      setRoomVisible: (visible) => this.view.showRoom(visible ? definition.building : null),
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
      resetDoors: () => this.doors?.reset(),
      resumeStreet: () => this.movement.exit(
        { x: this.position.x, y: this.position.y },
        () => this.reportTile(),
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
  }

  private exitAvatarStudioRoom(): void {
    this.avatarStudioActive = false;
    this.lastTile = { x: -1, y: -1 };
    try {
      this.avatarStudioPresentation?.exit();
    } catch (error) {
      // The controller restores its own room state when this handoff fails.
      // Keep the mode flag aligned with that retryable rollback unless the
      // callback already retired the session.
      if (!this.cleanedUp) this.avatarStudioActive = true;
      throw error;
    }
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
    this.stepPlayer(velocity, delta, {
      tileSize: FIXED_ROOM_TILE_SIZE,
      toTile: worldToRoomTile,
      isSolidAt: (x, y) => isFixedRoomSolidAt(map, x, y),
    });
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
    },
  ): boolean {
    if (velocity.x === 0 && velocity.y === 0) return false;
    const movement = {
      position: { x: this.position.x, y: this.position.y },
      velocity,
      delta,
      tileSize: grid.tileSize,
      collisionHalfSize: AVATAR_BODY_SIZE / 2,
      toTile: grid.toTile,
      isSolidAt: grid.isSolidAt,
    };
    const next = grid.heights
      ? moveOnHeightmap({ ...movement, heights: grid.heights })
      : moveWithCollisionSubsteps(movement);
    this.position = clampToRect(next, this.bounds);
    this.view.setPlayerPosition(this.position, false);
    return true;
  }

  private teleport(position: { readonly x: number; readonly y: number }): void {
    this.position = { x: position.x, y: position.y };
    this.view.setPlayerPosition(this.position, true);
    // Room spawns and street return tiles are never in the sandbox.
    this.setElevation(0);
    this.setAim(null);
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
    const keyboard = this.keyboard;
    if (!keyboard) return;
    const onKey = (event: { readonly repeat: boolean; readonly target: unknown }): void => {
      if (this.cleanedUp || event.repeat) return;
      if (this.inputGate.suspended || this.area !== 'street') return;
      const aim = this.aim;
      if (!aim || !aim.valid) return;
      if (aim.mode === 'pick') channel.pick(aim.tile);
      else channel.place(aim.tile);
    };
    keyboard.on('keydown-E', onKey);
    this.sandboxKey = onKey;
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
    if (!this.avatarStudioActive && isAvatarStudioEntrance(this.map, tile.x, tile.y)) {
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
    const tile = worldToRoomTile(this.position.x, this.position.y);
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

  private activeRoomMap(): FixedRoomMap | undefined {
    return this.activeRoom ? this.roomMaps[this.activeRoom] : undefined;
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
