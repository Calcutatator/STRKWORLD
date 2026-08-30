import type * as PhaserTypes from 'phaser';

interface CurrentWorldConfig {
  out: EventBus<WorldEvents>;
  in: EventBus<ShellEvents>;
  remotePeers?: RemotePeerSource;
}
import type {
  AvatarSpriteKey,
  BuildingId,
  EventBus,
  ShellEvents,
  StationId,
  WorldEvents,
} from '@strkworld/shared';
import {
  createStreetMap,
  isAvatarStudioEntrance,
  isSolidAt,
  TILE_SIZE,
  TILES,
  tileToWorld,
  worldToTile,
  type DistrictMap,
  type TileKind,
} from '../map/street.js';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_HEIGHT,
  AVATAR_STUDIO_TILE_SIZE,
  AVATAR_STUDIO_WIDTH,
  avatarStudioSpawnToWorld,
  avatarStudioTileColour,
  createAvatarStudioPresentation,
  createAvatarStudioController,
  isAvatarStudioSolidAt,
  type AvatarStudioPresentation,
  type AvatarStudioController,
} from '../avatar-studio.js';
import {
  createAvatarStudioFigureLayer,
  type AvatarStudioFigureLayer,
} from '../avatar-studio-figure-layer.js';
import {
  createAvatarOutfitSelection,
  createAvatarOutfitToggleBinding,
  type AvatarOutfitSelection,
  type AvatarOutfitToggleBinding,
} from '../avatar-outfit.js';
import { DEFAULT_AVATAR_SPRITE } from '../avatar-state.js';
import { createDoorTrigger, type DoorTrigger } from '../door-trigger.js';
import {
  FIXED_ROOM_DEFINITIONS,
  FIXED_ROOM_TILE_SIZE,
  createFixedRoom,
  createFixedRoomController,
  fixedRoomStationPresentations,
  isFixedRoomSolidAt,
  type FixedRoomController,
  type FixedRoomDefinition,
  type FixedRoomMap,
} from '../fixed-room.js';
import { createInputGate, type InputGate } from '../input-gate.js';
import {
  createStreetMovementAdapter,
  moveWithCollisionSubsteps,
  type MovementInput,
  type StreetMovementAdapter,
} from '../street-movement.js';
import {
  calculateMovementVelocity,
  createWasdKeyMapping,
  mergeMovementInput,
} from '../movement-input.js';
import { createRemoteAvatarLayer, type RemoteAvatarLayer } from '../remote-avatar-layer.js';
import type { RemotePeerSource } from '../remote-peer.js';
import {
  AVATAR_BODY_SIZE,
  createLocalAvatarVisual,
  preloadAvatarVisuals,
  registerAvatarAnimations,
  type LocalAvatarVisual,
} from '../avatar-visual.js';
import {
  createKenneyRuntimeTextures,
  KENNEY_ATLAS_KEY,
  KENNEY_ATLAS_URL,
  KENNEY_DOOR_TEXTURE_KEY,
  KENNEY_TILE_TEXTURE_KEY,
} from '../kenney-urban.js';

/**
 * The street.
 *
 * Placeholder street art is sliced at runtime from the audited Kenney CC0
 * atlas. Player and Studio avatar presentations use the final D-049 sheets;
 * grass remains procedural. Map data, collision and door contracts do not
 * change when the art treatment changes.
 *
 * No network I/O happens in scene lifecycle. Under any future mounting
 * regression `create()` can run twice, and a lobby join here would produce two
 * presence entries for one player. Joins are shell-driven and explicit.
 */

const ROOM_ORIGIN = { x: 2 * TILE_SIZE, y: 2 * TILE_SIZE };

type Scene = PhaserTypes.Scene;
type Sprite = PhaserTypes.Physics.Arcade.Sprite;

export interface StreetSceneDeps {
  /** Phaser namespace, injected so this module never value-imports it. */
  Phaser: typeof PhaserTypes;
  /** Called when the player's tile changes. The scene reports; it decides nothing. */
  onTileChanged?: (tile: { x: number; y: number }) => void;
  /** Optional retained presentation snapshots; the World owns the seam. */
  remotePeers?: RemotePeerSource;
}

export function createStreetScene({ Phaser, onTileChanged, remotePeers }: StreetSceneDeps) {
  return class StreetScene extends Phaser.Scene {
    private map!: DistrictMap;
    // Phaser 4 can return either renderer-backed layer type from createLayer.
    private ground?: PhaserTypes.Tilemaps.TilemapLayer | PhaserTypes.Tilemaps.TilemapGPULayer;
    private player!: Sprite;
    private playerOwned = false;
    private avatarVisual?: LocalAvatarVisual;
    private renderedAvatarSprite: AvatarSpriteKey = DEFAULT_AVATAR_SPRITE;
    private avatarVisualRevision = 0;
    private cursors!: PhaserTypes.Types.Input.Keyboard.CursorKeys;
    private wasd!: Record<'up' | 'down' | 'left' | 'right', PhaserTypes.Input.Keyboard.Key>;
    private lastTile = { x: -1, y: -1 };
    private doors!: DoorTrigger;
    private inputGate!: InputGate;
    private roomControllers!: Partial<Record<BuildingId, FixedRoomController>>;
    private roomMaps!: Partial<Record<BuildingId, FixedRoomMap>>;
    private activeRoom?: BuildingId;
    private avatarStudio?: AvatarStudioController;
    private avatarStudioPresentation?: AvatarStudioPresentation;
    private avatarOutfit: AvatarOutfitSelection = NOOP_AVATAR_OUTFIT;
    private avatarOutfitToggle?: AvatarOutfitToggleBinding;
    private avatarStudioActive = false;
    private movement!: StreetMovementAdapter;
    private roomGraphics?: PhaserTypes.GameObjects.Graphics;
    private roomLabels = new Map<StationId, PhaserTypes.GameObjects.Text>();
    private exteriorLabels = new Map<BuildingId, PhaserTypes.GameObjects.Text>();
    private roomStationGraphics?: PhaserTypes.GameObjects.Graphics;
    private avatarStudioGraphics?: PhaserTypes.GameObjects.Graphics;
    private avatarStudioFigureLayer?: AvatarStudioFigureLayer;
    private doorOverlays: PhaserTypes.GameObjects.Image[] = [];
    private remoteAvatars?: RemoteAvatarLayer;
    private returnTile = { x: 0, y: 0 };
    private cleanedUp = true;

    constructor() {
      super({ key: 'street' });
    }

    preload(): void {
      this.map = createStreetMap();
      this.load.image(KENNEY_ATLAS_KEY, KENNEY_ATLAS_URL);
      preloadAvatarVisuals(this);
    }

    create(): void {
      // Phaser restarts reuse this Scene instance. Each create owns a fresh set
      // of controllers, listeners and presentation objects to clean once.
      // A defensive repeated create can arrive without Phaser first delivering
      // shutdown. Retire only the World-owned cycle: broadcasting Phaser's
      // shutdown event here would also tear down its still-running plugins.
      this.retireWorldOwnership();
      this.cleanedUp = false;
      this.ground = undefined;
      this.playerOwned = false;
      this.lastTile = { x: -1, y: -1 };
      this.events.once('shutdown', this.cleanShutdown, this);
      try {
        createKenneyRuntimeTextures(this, Phaser, {
          tileIndex: TILE_INDEX,
          grassColour: TILES.grass.colour,
        });
        registerAvatarAnimations(this);
        this.drawGround();
        this.createDoorOverlays();
        this.movement = createStreetMovementAdapter({
          emit: (event, payload) => this.resolveWorldConfig()?.out.emit(event, payload),
        });
        this.createPlayer();
        const currentConfig = this.resolveWorldConfig();
        this.remoteAvatars = createRemoteAvatarLayer({
          scene: this,
          source: currentConfig ? currentConfig.remotePeers : remotePeers,
        });
        this.createInput();
        this.createAvatarOutfit();
        this.createFixedRooms();
        this.createAvatarStudio();
        this.createCamera();
        this.createDoorTriggers();
        this.createRoomVisuals();
        this.createExteriorLabels();
      } catch (error) {
        // Phaser calls Scene#create directly. If construction throws, it does
        // not emit shutdown, so retire the partial World cycle here without
        // broadcasting shutdown to Phaser's still-live plugins.
        this.events.off('shutdown', this.cleanShutdown, this);
        try {
          this.cleanShutdown();
        } catch {
          // The construction failure is the actionable public error. Cleanup
          // has already attempted every owned action; a secondary teardown
          // failure must not replace the original failure.
        }
        throw error;
      }
    }

    override update(_time: number, delta: number): void {
      if (this.cleanedUp) return;
      const room = this.activeRoomController();
      if (this.avatarStudioActive) {
        this.moveAvatarStudioPlayer(delta);
        return;
      }
      if (room?.state.inRoom) {
        this.moveRoomPlayer(delta);
        this.movement.interiorUpdate(() => this.reportRoomTile());
        return;
      }
      const input = this.movePlayer();
      this.movement.streetUpdate(
        { x: this.player.x, y: this.player.y },
        input,
        () => {
          if (this.cleanedUp) return;
          this.reportTile();
        },
      );
    }

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
      for (const room of Object.values(this.roomControllers ?? {})) {
        if (room) attempt(() => room.destroy());
      }
      this.roomControllers = {};
      this.roomMaps = {};
      this.activeRoom = undefined;
      this.avatarStudioActive = false;
      if (this.playerOwned) {
        const player = this.player;
        this.playerOwned = false;
        attempt(() => player.destroy());
      }
      const ground = this.ground;
      this.ground = undefined;
      if (ground) attempt(() => ground.destroy());
      this.avatarVisual = undefined;
      const avatarOutfitToggle = this.avatarOutfitToggle;
      this.avatarOutfitToggle = undefined;
      if (avatarOutfitToggle) attempt(() => avatarOutfitToggle.destroy());
      this.avatarOutfit = NOOP_AVATAR_OUTFIT;
      const avatarStudio = this.avatarStudio;
      this.avatarStudio = undefined;
      if (avatarStudio) attempt(() => avatarStudio.destroy());
      this.avatarStudioPresentation = undefined;
      const avatarStudioFigureLayer = this.avatarStudioFigureLayer;
      this.avatarStudioFigureLayer = undefined;
      if (avatarStudioFigureLayer) attempt(() => avatarStudioFigureLayer.destroy());
      const inputGate = this.inputGate;
      this.inputGate = NOOP_INPUT_GATE;
      if (inputGate) attempt(() => inputGate.resume());
      const roomGraphics = this.roomGraphics;
      this.roomGraphics = undefined;
      if (roomGraphics) attempt(() => roomGraphics.destroy());
      const roomStationGraphics = this.roomStationGraphics;
      this.roomStationGraphics = undefined;
      if (roomStationGraphics) attempt(() => roomStationGraphics.destroy());
      const avatarStudioGraphics = this.avatarStudioGraphics;
      this.avatarStudioGraphics = undefined;
      if (avatarStudioGraphics) attempt(() => avatarStudioGraphics.destroy());
      const roomLabels = [...this.roomLabels.values()];
      this.roomLabels.clear();
      for (const label of roomLabels) attempt(() => label.destroy());
      const exteriorLabels = [...this.exteriorLabels.values()];
      this.exteriorLabels.clear();
      for (const label of exteriorLabels) attempt(() => label.destroy());
      const remoteAvatars = this.remoteAvatars;
      this.remoteAvatars = undefined;
      if (remoteAvatars) attempt(() => remoteAvatars.destroy());
      const doorOverlays = this.doorOverlays;
      this.doorOverlays = [];
      for (const overlay of doorOverlays) attempt(() => overlay.destroy());
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'StreetScene cleanup failed');
    }

    private retireWorldOwnership(): void {
      if (this.cleanedUp) return;
      let detachError: unknown;
      let detachFailed = false;
      try {
        this.events.off('shutdown', this.cleanShutdown, this);
      } catch (error) {
        // Cleanup remains mandatory even if the framework refuses to remove
        // the old hook. The cleanup guard makes a later stale hook harmless.
        detachFailed = true;
        detachError = error;
      }

      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        this.cleanShutdown();
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }

      if (detachFailed && cleanupFailed) {
        throw new AggregateError(
          [detachError, cleanupError],
          'StreetScene restart cleanup failed',
        );
      }
      if (detachFailed) throw detachError;
      if (cleanupFailed) throw cleanupError;
    }

    // -- construction --------------------------------------------------------

    /**
     * Ground is a real tilemap layer, not a sprite per tile.
     *
     * A 48x28 grid is 1,344 tiles; as individual sprites that is a needless
     * draw-call cost for something that never changes. Using a tilemap also
     * means the Tiled import later swaps the *data source* only — the
     * rendering and collision paths stay exactly as they are.
     */
    private drawGround(): void {
      const indices = this.map.tiles.map((row) => row.map((kind) => TILE_INDEX[kind]));
      const tilemap = this.make.tilemap({
        data: indices,
        tileWidth: TILE_SIZE,
        tileHeight: TILE_SIZE,
      });
      const tileset = tilemap.addTilesetImage(
        KENNEY_TILE_TEXTURE_KEY,
        KENNEY_TILE_TEXTURE_KEY,
        TILE_SIZE,
        TILE_SIZE,
        0,
        0,
      );
      if (!tileset) return;

      const layer = tilemap.createLayer(0, tileset, 0, 0);
      if (!layer) return;
      this.ground = layer;
      layer.setDepth(0);

      // Collision from the same indices the unit tests assert against, so
      // there is no second representation of "solid" to drift out of step.
      const solidIndices = Object.values(TILES)
        .filter((spec) => spec.solid)
        .map((spec) => TILE_INDEX[spec.kind]);
      layer.setCollision(solidIndices);

    }

    /** Door art is an overlay so it never changes the tile/index/collision map. */
    private createDoorOverlays(): void {
      for (const door of this.map.doors) {
        const layout = doorOverlayLayout(door);
        const overlay = this.add.image(
          layout.x,
          layout.y,
          KENNEY_DOOR_TEXTURE_KEY,
        );
        this.doorOverlays.push(overlay);
        overlay.setDisplaySize(layout.width, layout.height).setDepth(1);
      }
    }

    private createPlayer(): void {
      const spawn = tileToWorld(this.map.spawn.x, this.map.spawn.y);
      this.player = this.physics.add.sprite(spawn.x, spawn.y, DEFAULT_AVATAR_SPRITE, 0);
      this.playerOwned = true;
      this.player.setDepth(10);
      this.player.setCollideWorldBounds(true);
      this.avatarVisual = createLocalAvatarVisual(this.player, DEFAULT_AVATAR_SPRITE);
      this.renderedAvatarSprite = DEFAULT_AVATAR_SPRITE;
      this.avatarVisualRevision = 0;
      this.physics.world.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);

      if (this.ground) this.physics.add.collider(this.player, this.ground);
      this.movement.initial({ x: this.player.x, y: this.player.y });
    }

    private createInput(): void {
      const keyboard = this.input.keyboard;
      if (!keyboard) {
        this.inputGate = NOOP_INPUT_GATE;
        return;
      }
      this.cursors = keyboard.createCursorKeys();
      this.wasd = keyboard.addKeys(
        createWasdKeyMapping({
          W: Phaser.Input.Keyboard.KeyCodes.W,
          A: Phaser.Input.Keyboard.KeyCodes.A,
          S: Phaser.Input.Keyboard.KeyCodes.S,
          D: Phaser.Input.Keyboard.KeyCodes.D,
        }),
      ) as typeof this.wasd;
      this.inputGate = createInputGate(keyboard);
    }

    /**
     * One outfit selection and one F binding for the whole Scene (D-053).
     *
     * Both are created here, before the rooms and the Studio, because they
     * share the selection. Buildings and the Studio never own a binding of
     * their own; if they did, the toggle would work in whichever of them
     * happened to be active and nowhere else — which is the D-052 behaviour
     * D-053 replaces.
     *
     * Re-running this (a same-instance restart) replaces the binding rather
     * than adding a second listener.
     */
    private createAvatarOutfit(): void {
      this.avatarOutfitToggle?.destroy();
      this.avatarOutfitToggle = undefined;
      this.avatarOutfit = createAvatarOutfitSelection({
        out: {
          // The bus is resolved per emit for the reason given on
          // createDoorTriggers: the registry entry is set in preBoot, and
          // resolving late keeps this correct if that ordering ever shifts.
          emit: (event, payload) => {
            if (event === 'avatar:selected') {
              const sprite = (payload as WorldEvents['avatar:selected']).sprite;
              const previousSprite = this.renderedAvatarSprite;
              const previousRevision = this.avatarVisualRevision;
              try {
                this.applyAvatarSprite(sprite);
                this.resolveWorldConfig()?.out?.emit(event, payload);
              } catch (error) {
                // Selection rolls back its logical state when shell delivery
                // fails. Keep the Phaser visual in that same transaction, but
                // do not undo a newer reentrant selection made by the shell.
                if (
                  this.avatarVisualRevision === previousRevision + 1 &&
                  this.renderedAvatarSprite === sprite
                ) {
                  try {
                    this.applyAvatarSprite(previousSprite);
                  } catch {
                    // Preserve the original shell/visual error.
                  }
                }
                throw error;
              }
              return;
            }
            this.resolveWorldConfig()?.out?.emit(event, payload);
          },
        },
      });
      const keyboard = this.input.keyboard;
      if (!keyboard) return;
      this.avatarOutfitToggle = createAvatarOutfitToggleBinding({
        keyboard,
        // Playable everywhere the avatar is: outdoors, in the Studio and in a
        // room. The one thing that silences F is the gate — a panel or a Shell
        // control claim has the keyboard, and stealing a keystroke back from a
        // focused input is exactly the bug input-gate.ts exists to prevent.
        isActive: () => this.inputGate?.suspended !== true,
        toggle: () => this.avatarOutfit.toggle(),
      });
    }

    private createCamera(): void {
      const camera = this.cameras.main;
      camera.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);
      // Horizontal follow is immediate so pixel-art edges stay stable while
      // moving east/west. Keep the slight vertical ease for camera feel.
      camera.startFollow(this.player, true, 1, 0.12);
      camera.setZoom(2);
    }

    /**
     * Door triggers emit onto the world's outbound bus. The bus is read lazily
     * from the registry at emit time rather than cached here: the shell sets it
     * in `preBoot`, before Phaser creates the scene, so it is present by
     * `create()` — but resolving it per-emit keeps the scene correct if that
     * ordering ever shifts, and a no-op when there is no bus (headless boot).
     *
     * No network I/O and no wallet: emitting a semantic event is all that
     * happens. The door-trigger state machine itself is tested headlessly.
     */
    private createDoorTriggers(): void {
      const out: Pick<EventBus<WorldEvents>, 'emit'> = {
        emit: (event, payload) => {
          // Enter the local room before publishing the semantic event.  The
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
                // presentation handoff fails. Clear the Scene's provisional
                // room ownership too, unless a nested transition or teardown
                // has already replaced it.
                if (this.activeRoom === entered.building && !this.cleanedUp) {
                  this.activeRoom = undefined;
                }
                throw error;
              }
            }
          } else if (event === 'building:exited') {
            this.inputGate.resume();
          }
          this.resolveWorldConfig()?.out?.emit(event, payload);
        },
      };
      this.doors = createDoorTrigger(this.map, out);
    }

    /** Build all configured rooms; the Phaser scene remains the sole adapter. */
    private createFixedRooms(): void {
      this.roomMaps = {};
      this.roomControllers = {};
      const bus = this.resolveWorldConfig();
      const out: Pick<EventBus<WorldEvents>, 'emit'> = {
        emit: (event, payload) => bus?.out?.emit(event, payload),
      };
      for (const definition of Object.values(FIXED_ROOM_DEFINITIONS)) {
        const building = definition.building;
        this.roomMaps[building] = createFixedRoom(definition);
        this.roomControllers[building] = createFixedRoomController({
          definition,
          out,
          in: bus?.in,
          input: this.inputGate,
          onEnter: () => this.enterRoom(definition),
          onExit: () => this.exitRoom(definition),
          onChange: () => this.renderRoom(),
        });
      }
    }

    private createAvatarStudio(): void {
      const bus = this.resolveWorldConfig();
      const streetBounds = {
        x: 0,
        y: 0,
        width: this.map.width * TILE_SIZE,
        height: this.map.height * TILE_SIZE,
      };
      const studioBounds = {
        x: ROOM_ORIGIN.x,
        y: ROOM_ORIGIN.y,
        width: AVATAR_STUDIO_WIDTH * AVATAR_STUDIO_TILE_SIZE,
        height: AVATAR_STUDIO_HEIGHT * AVATAR_STUDIO_TILE_SIZE,
      };
      this.avatarStudioPresentation = createAvatarStudioPresentation({
        port: {
          setPlayerVelocity: (x, y) => this.player.setVelocity(x, y),
          setBodyEnabled: (enabled) => (this.player.body as PhaserTypes.Physics.Arcade.Body).setEnable(enabled),
          setGroundVisible: (visible) => this.ground?.setVisible(visible),
          setDoorsVisible: (visible) => this.doorOverlays.forEach((overlay) => overlay.setVisible(visible)),
          setRemoteVisible: (visible) => this.remoteAvatars?.setVisible(visible),
          setLabelsVisible: (visible) => this.exteriorLabels.forEach((label) => label.setVisible(visible)),
          setRoomVisible: (visible) => {
            this.roomGraphics?.setVisible(visible);
            this.roomStationGraphics?.setVisible(visible);
          },
          setStudioVisible: (visible) => {
            this.avatarStudioGraphics?.setVisible(visible);
            this.avatarStudioFigureLayer?.sync({
              visible,
              highlightedFigure: visible
                ? this.avatarStudio?.state.highlightedFigure ?? null
                : null,
            });
          },
          setWorldBounds: (bounds) => this.physics.world.setBounds(bounds.x, bounds.y, bounds.width, bounds.height),
          setCameraBounds: (bounds) => this.cameras.main.setBounds(bounds.x, bounds.y, bounds.width, bounds.height),
          setPlayerPosition: (position) => this.player.setPosition(position.x, position.y),
          resetDoors: () => this.doors?.reset(),
          resumeStreet: (position, report) => this.movement.exit(position, report),
          destroyStudio: () => {
            this.avatarStudioGraphics?.clear();
            this.avatarStudioFigureLayer?.destroy();
            this.avatarStudioFigureLayer = undefined;
          },
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
        out: { emit: (event, payload) => bus?.out?.emit(event, payload) },
        selection: this.avatarOutfit,
        onEnter: () => this.enterAvatarStudioRoom(),
        onExit: () => this.exitAvatarStudioRoom(),
        onChange: () => this.renderAvatarStudio(),
        onDestroy: () => this.avatarStudioPresentation?.destroy(),
      });
    }

    private resolveWorldConfig(): CurrentWorldConfig | undefined {
      const game = this.game as PhaserTypes.Game | undefined;
      return game?.registry.get('bus') as CurrentWorldConfig | undefined;
    }

    private createRoomVisuals(): void {
      const roomGraphics = this.add.graphics();
      this.roomGraphics = roomGraphics;
      roomGraphics.setDepth(1);
      const roomStationGraphics = this.add.graphics();
      this.roomStationGraphics = roomStationGraphics;
      roomStationGraphics.setDepth(2);
      const avatarStudioGraphics = this.add.graphics();
      this.avatarStudioGraphics = avatarStudioGraphics;
      avatarStudioGraphics.setDepth(1);
      this.avatarStudioFigureLayer = createAvatarStudioFigureLayer({
        scene: this,
        roomOrigin: ROOM_ORIGIN,
      });
      this.roomGraphics.setVisible(false);
      this.roomStationGraphics.setVisible(false);
      this.avatarStudioGraphics.setVisible(false);
    }

    /** Render non-interactive placeholder signs over the street facades. */
    private createExteriorLabels(): void {
      for (const exterior of this.map.exteriorLabels) {
        const position = tileToWorld(exterior.x, exterior.y);
        const label = this.add.text(position.x, position.y, exterior.text, {
          color: '#f4e9c9',
          fontFamily: 'monospace',
          fontSize: '10px',
          align: 'center',
          stroke: '#2b2b33',
          strokeThickness: 3,
        });
        this.exteriorLabels.set(exterior.building, label);
        label.setOrigin(0.5).setDepth(3);
      }
    }

    private enterRoom(definition: FixedRoomDefinition): void {
      this.player.setVelocity(0, 0);
      const body = this.player.body as PhaserTypes.Physics.Arcade.Body;
      body.setEnable(false);
      this.ground?.setVisible(false);
      for (const overlay of this.doorOverlays) overlay.setVisible(false);
      this.remoteAvatars?.setVisible(false);
      for (const label of this.exteriorLabels.values()) label.setVisible(false);
      this.roomGraphics?.setVisible(true);
      this.roomStationGraphics?.setVisible(true);
      this.physics.world.setBounds(
        ROOM_ORIGIN.x,
        ROOM_ORIGIN.y,
        definition.width * FIXED_ROOM_TILE_SIZE,
        definition.height * FIXED_ROOM_TILE_SIZE,
      );
      this.player.setPosition(
        ROOM_ORIGIN.x + definition.spawn.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
        ROOM_ORIGIN.y + definition.spawn.y * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
      );
      this.cameras.main.setBounds(
        ROOM_ORIGIN.x,
        ROOM_ORIGIN.y,
        definition.width * FIXED_ROOM_TILE_SIZE,
        definition.height * FIXED_ROOM_TILE_SIZE,
      );
      this.lastTile = { x: -1, y: -1 };
      this.renderRoom();
    }

    private exitRoom(_definition: FixedRoomDefinition): void {
      this.player.setVelocity(0, 0);
      const body = this.player.body as PhaserTypes.Physics.Arcade.Body;
      body.setEnable(true);
      this.ground?.setVisible(true);
      for (const overlay of this.doorOverlays) overlay.setVisible(true);
      this.remoteAvatars?.setVisible(true);
      for (const label of this.exteriorLabels.values()) label.setVisible(true);
      this.roomGraphics?.setVisible(false);
      this.roomStationGraphics?.setVisible(false);
      for (const label of this.roomLabels.values()) label.setVisible(false);
      this.physics.world.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);
      this.cameras.main.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);
      const world = tileToWorld(this.returnTile.x, this.returnTile.y);
      this.player.setPosition(world.x, world.y);
      this.lastTile = { x: -1, y: -1 };
      // The door trigger is reset by reporting the safe approach tile; the
      // next physical approach can therefore enter once again.
      this.doors?.reset();
      // Rejoin presence at the restored street placement before the room
      // controller publishes building:exited.
      this.movement.exit({ x: this.player.x, y: this.player.y }, () => this.reportTile());
      this.activeRoom = undefined;
    }

    private enterAvatarStudioRoom(): void {
      this.avatarStudioActive = true;
      this.activeRoom = undefined;
      this.lastTile = { x: -1, y: -1 };
      try {
        this.avatarStudioPresentation?.enter();
      } catch (error) {
        // The controller rolls back its own room state when this presentation
        // handoff fails. Keep the Scene's mode flag aligned with that rollback
        // so a later update cannot run the player through a retired Studio.
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
        // The controller restores its own room state when this presentation
        // handoff fails. Keep the Scene's mode flag aligned with that retryable
        // rollback unless the callback already retired the Scene.
        if (!this.cleanedUp) this.avatarStudioActive = true;
        throw error;
      }
    }

    private renderAvatarStudio(): void {
      if (!this.avatarStudioGraphics) return;
      this.avatarStudioGraphics.clear();
      if (!this.avatarStudioActive) {
        this.avatarStudioFigureLayer?.sync({ visible: false, highlightedFigure: null });
        return;
      }
      for (let y = 0; y < AVATAR_STUDIO_HEIGHT; y += 1) {
        for (let x = 0; x < AVATAR_STUDIO_WIDTH; x += 1) {
          this.avatarStudioGraphics.fillStyle(
            avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, x, y),
            1,
          );
          this.avatarStudioGraphics.fillRect(
            ROOM_ORIGIN.x + x * AVATAR_STUDIO_TILE_SIZE,
            ROOM_ORIGIN.y + y * AVATAR_STUDIO_TILE_SIZE,
            AVATAR_STUDIO_TILE_SIZE,
            AVATAR_STUDIO_TILE_SIZE,
          );
        }
      }
      this.avatarStudioFigureLayer?.sync({
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
      if (!this.roomGraphics || !this.roomStationGraphics) return;
      const controller = this.activeRoomController();
      const map = this.activeRoomMap();
      if (!controller || !map) return;
      const state = controller.state;
      this.roomGraphics.clear();
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const tile = map.tiles[y]?.[x];
          const colour = tile === 'wall' ? 0x39343b : tile === 'exit' ? 0x8a7c62 : 0x514c5a;
          this.roomGraphics.fillStyle(colour, 1);
          this.roomGraphics.fillRect(
            ROOM_ORIGIN.x + x * FIXED_ROOM_TILE_SIZE,
            ROOM_ORIGIN.y + y * FIXED_ROOM_TILE_SIZE,
            FIXED_ROOM_TILE_SIZE,
            FIXED_ROOM_TILE_SIZE,
          );
        }
      }
      this.roomStationGraphics.clear();
      for (const label of this.roomLabels.values()) label.setVisible(false);
      for (const station of fixedRoomStationPresentations(map, state)) {
        this.roomStationGraphics.fillStyle(
          station.status === 'available' ? (station.highlighted ? 0xe2b45d : 0xb07b41) : 0x665f67,
          1,
        );
        this.roomStationGraphics.fillRect(
          ROOM_ORIGIN.x + station.x * FIXED_ROOM_TILE_SIZE,
          ROOM_ORIGIN.y + station.y * FIXED_ROOM_TILE_SIZE,
          station.width * FIXED_ROOM_TILE_SIZE,
          station.height * FIXED_ROOM_TILE_SIZE,
        );
        let label = this.roomLabels.get(station.station);
        if (!label) {
          label = this.add
            .text(0, 0, '', {
              color: '#f4e9c9',
              fontFamily: 'monospace',
              fontSize: '12px',
              align: 'center',
            });
          this.roomLabels.set(station.station, label);
          label.setOrigin(0.5).setDepth(3);
        }
        label
          .setVisible(true)
          .setText(station.label)
          .setPosition(
            ROOM_ORIGIN.x + (station.x + station.width / 2) * FIXED_ROOM_TILE_SIZE,
            ROOM_ORIGIN.y + (station.y - 0.65) * FIXED_ROOM_TILE_SIZE,
          );
      }
    }

    // -- per frame -----------------------------------------------------------

    private movePlayer(): MovementInput {
      if (!this.cursors) return NO_MOVEMENT;
      const held = this.heldDirections();
      const sprinting = this.sprinting();
      const velocity = calculateMovementVelocity(held, sprinting);
      const body = this.player.body as PhaserTypes.Physics.Arcade.Body;
      body.setVelocity(velocity.x, velocity.y);
      this.avatarVisual?.update(held, sprinting);
      return held;
    }

    private moveRoomPlayer(delta: number): void {
      const controller = this.activeRoomController();
      const map = this.activeRoomMap();
      if (!this.cursors || !controller || !map || controller.state.controlOwner !== 'world') {
        this.avatarVisual?.update(NO_MOVEMENT, false);
        return;
      }
      const held = this.heldDirections();
      const sprinting = this.sprinting();
      const velocity = calculateMovementVelocity(held, sprinting);
      this.avatarVisual?.update(held, sprinting);
      if (velocity.x === 0 && velocity.y === 0) return;
      const position = moveWithCollisionSubsteps({
        position: { x: this.player.x, y: this.player.y },
        velocity,
        delta,
        tileSize: FIXED_ROOM_TILE_SIZE,
        collisionHalfSize: AVATAR_BODY_SIZE / 2,
        toTile: worldToRoomTile,
        isSolidAt: (x, y) => isFixedRoomSolidAt(map, x, y),
      });
      this.player.setPosition(position.x, position.y);
    }

    private moveAvatarStudioPlayer(delta: number): void {
      if (!this.cursors || !this.avatarStudio?.state.inRoom) {
        this.avatarVisual?.update(NO_MOVEMENT, false);
        return;
      }
      const held = this.heldDirections();
      const sprinting = this.sprinting();
      const velocity = calculateMovementVelocity(held, sprinting);
      this.avatarVisual?.update(held, sprinting);
      if (velocity.x === 0 && velocity.y === 0) return;
      const position = moveWithCollisionSubsteps({
        position: { x: this.player.x, y: this.player.y },
        velocity,
        delta,
        tileSize: AVATAR_STUDIO_TILE_SIZE,
        collisionHalfSize: AVATAR_BODY_SIZE / 2,
        toTile: worldToRoomTile,
        isSolidAt: (x, y) => isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, x, y),
      });
      this.player.setPosition(position.x, position.y);
      this.movement.interiorUpdate(() => this.reportAvatarStudioTile());
    }

    private heldDirections() {
      if (!this.cursors) return NO_MOVEMENT;
      return mergeMovementInput(
        {
          left: this.cursors.left.isDown,
          right: this.cursors.right.isDown,
          up: this.cursors.up.isDown,
          down: this.cursors.down.isDown,
        },
        {
          left: this.wasd?.left?.isDown ?? false,
          right: this.wasd?.right?.isDown ?? false,
          up: this.wasd?.up?.isDown ?? false,
          down: this.wasd?.down?.isDown ?? false,
        },
      );
    }

    private sprinting(): boolean {
      return this.cursors?.shift?.isDown ?? false;
    }

    private reportTile(): void {
      const tile = worldToTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      if (!this.avatarStudioActive && isAvatarStudioEntrance(this.map, tile.x, tile.y)) {
        this.avatarStudio?.enter();
        // Avatar Studio entry is an external lifecycle boundary. Commit the
        // tile only after the transition succeeds so a failed entry can retry
        // while the player remains on the entrance.
        if (this.cleanedUp) return;
        this.lastTile = tile;
        return;
      }
      // Keep the sentinel committed during delivery so a nested report cannot
      // re-enter the same tile. If the door handoff fails, however, the
      // trigger restores its own occupancy and this Scene must leave the tile
      // retryable as well. A nested transition may already have taken over;
      // only roll back this attempt's own commit in that case.
      const previousTile = this.lastTile;
      this.lastTile = tile;
      try {
        this.doors.update(tile);
      } catch (error) {
        if (this.lastTile === tile) this.lastTile = previousTile;
        throw error;
      }
      if (this.cleanedUp) return;
      try {
        onTileChanged?.(tile);
      } catch (error) {
        // The tile observer is an external synchronous handoff. If it fails,
        // keep this tile retryable unless a nested report or teardown already
        // took ownership of the Scene's newer state.
        if (!this.cleanedUp && this.lastTile === tile) this.lastTile = previousTile;
        throw error;
      }
    }

    private reportAvatarStudioTile(): void {
      const tile = worldToRoomTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      const previousTile = this.lastTile;
      this.lastTile = tile;
      try {
        this.avatarStudio?.update(tile);
      } catch (error) {
        // Studio callbacks are synchronous and may fail at the shell boundary.
        // Keep this tile retryable unless a nested report has already replaced
        // the Scene's sentinel with newer ownership.
        if (this.lastTile === tile) this.lastTile = previousTile;
        throw error;
      }
    }

    private applyAvatarSprite(sprite: AvatarSpriteKey): void {
      this.avatarVisual?.select(sprite);
      this.renderedAvatarSprite = sprite;
      this.avatarVisualRevision += 1;
    }

    private reportRoomTile(): void {
      const tile = worldToRoomTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      const previousTile = this.lastTile;
      this.lastTile = tile;
      try {
        this.activeRoomController()?.update(tile);
      } catch (error) {
        // Station activation is a synchronous shell handoff. Keep this tile
        // retryable when delivery fails, unless a nested transition or Scene
        // teardown has already replaced the sentinel with newer ownership.
        if (!this.cleanedUp && this.lastTile === tile) this.lastTile = previousTile;
        throw error;
      }
    }

    private activeRoomController(): FixedRoomController | undefined {
      return this.activeRoom ? this.roomControllers?.[this.activeRoom] : undefined;
    }

    private activeRoomMap(): FixedRoomMap | undefined {
      return this.activeRoom ? this.roomMaps?.[this.activeRoom] : undefined;
    }
  };
}

/** A destroyed Scene has no outfit to change; keep the field non-optional. */
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

const NO_MOVEMENT: MovementInput = {
  left: false,
  right: false,
  up: false,
  down: false,
};

/** Keep a two-tile visual surround centered over the unchanged trigger zone. */
export function doorOverlayLayout(
  door: Pick<DistrictMap['doors'][number], 'x' | 'y' | 'width' | 'height'>,
): { x: number; y: number; width: number; height: number } {
  return {
    x: (door.x + door.width / 2) * TILE_SIZE,
    y: (door.y + door.height / 2) * TILE_SIZE,
    width: door.width * TILE_SIZE,
    height: TILE_SIZE,
  };
}

function worldToRoomTile(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.floor((x - ROOM_ORIGIN.x) / FIXED_ROOM_TILE_SIZE),
    y: Math.floor((y - ROOM_ORIGIN.y) / FIXED_ROOM_TILE_SIZE),
  };
}

/** Index of each tile kind within the generated tileset strip. */
export const TILE_INDEX: Readonly<Record<TileKind, number>> = Object.freeze({
  grass: 0,
  road: 1,
  pavement: 2,
  wall: 3,
  facade: 4,
});
