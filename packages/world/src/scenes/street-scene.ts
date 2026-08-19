import type * as PhaserTypes from 'phaser';
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
import { avatarPlaceholderTint, DEFAULT_AVATAR_SPRITE } from '../avatar-state.js';
export { avatarPlaceholderTint } from '../avatar-state.js';
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
 * atlas; grass and the player remain procedural. The map data, collision and
 * door contracts do not change when the art treatment changes.
 *
 * No network I/O happens in scene lifecycle. Under any future mounting
 * regression `create()` can run twice, and a lobby join here would produce two
 * presence entries for one player. Joins are shell-driven and explicit.
 */

const PLAYER_SIZE = 24;
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
    private avatarStudioActive = false;
    private movement!: StreetMovementAdapter;
    private roomGraphics?: PhaserTypes.GameObjects.Graphics;
    private roomLabels = new Map<StationId, PhaserTypes.GameObjects.Text>();
    private exteriorLabels = new Map<BuildingId, PhaserTypes.GameObjects.Text>();
    private roomStationGraphics?: PhaserTypes.GameObjects.Graphics;
    private avatarStudioGraphics?: PhaserTypes.GameObjects.Graphics;
    private avatarStudioFigures = new Map<number, PhaserTypes.GameObjects.Image>();
    private doorOverlays: PhaserTypes.GameObjects.Image[] = [];
    private remoteAvatars?: RemoteAvatarLayer;
    private returnTile = { x: 0, y: 0 };
    private cleanedUp = false;

    constructor() {
      super({ key: 'street' });
    }

    preload(): void {
      this.map = createStreetMap();
      this.load.image(KENNEY_ATLAS_KEY, KENNEY_ATLAS_URL);
    }

    create(): void {
      createKenneyRuntimeTextures(this, Phaser, {
        tileIndex: TILE_INDEX,
        grassColour: TILES.grass.colour,
      });
      makePlayerTexture(this);
      this.drawGround();
      this.createDoorOverlays();
      this.movement = createStreetMovementAdapter({
        emit: (event, payload) => this.resolveBus()?.out.emit(event, payload),
      });
      this.createPlayer();
      this.remoteAvatars = createRemoteAvatarLayer({
        scene: this,
        source: remotePeers,
      });
      this.createInput();
      this.createFixedRooms();
      this.createAvatarStudio();
      this.createCamera();
      this.createDoorTriggers();
      this.createRoomVisuals();
      this.createExteriorLabels();
      this.events.once('shutdown', this.cleanShutdown, this);
    }

    override update(_time: number, delta: number): void {
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
      this.movement.streetUpdate({ x: this.player.x, y: this.player.y }, input, () =>
        this.reportTile(),
      );
    }

    private cleanShutdown(): void {
      if (this.cleanedUp) return;
      this.cleanedUp = true;
      for (const room of Object.values(this.roomControllers ?? {})) room?.destroy();
      this.avatarStudio?.destroy();
      this.avatarStudio = undefined;
      this.avatarStudioPresentation = undefined;
      this.inputGate?.resume();
      this.roomGraphics?.destroy();
      this.roomStationGraphics?.destroy();
      this.avatarStudioGraphics?.destroy();
      this.avatarStudioGraphics = undefined;
      for (const label of this.roomLabels.values()) label.destroy();
      this.roomLabels.clear();
      for (const label of this.exteriorLabels.values()) label.destroy();
      this.exteriorLabels.clear();
      this.remoteAvatars?.destroy();
      this.remoteAvatars = undefined;
      for (const overlay of this.doorOverlays) overlay.destroy();
      this.doorOverlays = [];
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
      layer.setDepth(0);

      // Collision from the same indices the unit tests assert against, so
      // there is no second representation of "solid" to drift out of step.
      const solidIndices = Object.values(TILES)
        .filter((spec) => spec.solid)
        .map((spec) => TILE_INDEX[spec.kind]);
      layer.setCollision(solidIndices);

      this.ground = layer;
    }

    /** Door art is an overlay so it never changes the tile/index/collision map. */
    private createDoorOverlays(): void {
      for (const door of this.map.doors) {
        const layout = doorOverlayLayout(door);
        const overlay = this.add
          .image(
            layout.x,
            layout.y,
            KENNEY_DOOR_TEXTURE_KEY,
          )
          .setDisplaySize(layout.width, layout.height)
          .setDepth(1);
        this.doorOverlays.push(overlay);
      }
    }

    private createPlayer(): void {
      const spawn = tileToWorld(this.map.spawn.x, this.map.spawn.y);
      this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player');
      this.player.setDepth(10);
      this.player.setCollideWorldBounds(true);
      this.physics.world.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);

      if (this.ground) this.physics.add.collider(this.player, this.ground);
      this.applyAvatarSprite(DEFAULT_AVATAR_SPRITE);
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

    private createCamera(): void {
      const camera = this.cameras.main;
      camera.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);
      // Slight lerp so the camera feels attached rather than welded.
      camera.startFollow(this.player, true, 0.12, 0.12);
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
            if (this.roomControllers[entered.building]) {
              this.returnTile = this.roomDoorReturnTile(entered.building);
              this.activeRoom = entered.building;
              this.roomControllers[entered.building]!.enter();
            }
          } else if (event === 'building:exited') {
            this.inputGate.resume();
          }
          this.resolveBus()?.out?.emit(event, payload);
        },
      };
      this.doors = createDoorTrigger(this.map, out);
    }

    /** Build all configured rooms; the Phaser scene remains the sole adapter. */
    private createFixedRooms(): void {
      this.roomMaps = {};
      this.roomControllers = {};
      const bus = this.resolveBus();
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
      const bus = this.resolveBus();
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
            if (!visible) this.avatarStudioFigures.forEach((figure) => figure.setVisible(false));
          },
          setWorldBounds: (bounds) => this.physics.world.setBounds(bounds.x, bounds.y, bounds.width, bounds.height),
          setCameraBounds: (bounds) => this.cameras.main.setBounds(bounds.x, bounds.y, bounds.width, bounds.height),
          setPlayerPosition: (position) => this.player.setPosition(position.x, position.y),
          resetDoors: () => this.doors?.reset(),
          resumeStreet: (position, report) => this.movement.exit(position, report),
          destroyStudio: () => {
            this.avatarStudioGraphics?.clear();
            for (const figure of this.avatarStudioFigures.values()) figure.destroy();
            this.avatarStudioFigures.clear();
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
      const out: Pick<EventBus<WorldEvents>, 'emit'> = {
        emit: (event, payload) => {
          if (event === 'avatar:selected') {
            this.applyAvatarSprite((payload as WorldEvents['avatar:selected']).sprite);
          }
          bus?.out?.emit(event, payload);
        },
      };
      this.avatarStudio = createAvatarStudioController({
        out,
        onEnter: () => this.enterAvatarStudioRoom(),
        onExit: () => this.exitAvatarStudioRoom(),
        onChange: () => this.renderAvatarStudio(),
        onDestroy: () => this.avatarStudioPresentation?.destroy(),
      });
    }

    private resolveBus(): { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } | undefined {
      return this.game.registry.get('bus') as
        { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } | undefined;
    }

    private createRoomVisuals(): void {
      this.roomGraphics = this.add.graphics().setDepth(1);
      this.roomStationGraphics = this.add.graphics().setDepth(2);
      this.avatarStudioGraphics = this.add.graphics().setDepth(1);
      this.roomGraphics.setVisible(false);
      this.roomStationGraphics.setVisible(false);
      this.avatarStudioGraphics.setVisible(false);
    }

    /** Render non-interactive placeholder signs over the street facades. */
    private createExteriorLabels(): void {
      for (const exterior of this.map.exteriorLabels) {
        const position = tileToWorld(exterior.x, exterior.y);
        const label = this.add
          .text(position.x, position.y, exterior.text, {
            color: '#f4e9c9',
            fontFamily: 'monospace',
            fontSize: '10px',
            align: 'center',
            stroke: '#2b2b33',
            strokeThickness: 3,
          })
          .setOrigin(0.5)
          .setDepth(3);
        this.exteriorLabels.set(exterior.building, label);
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
      this.avatarStudioPresentation?.enter();
    }

    private exitAvatarStudioRoom(): void {
      this.avatarStudioActive = false;
      this.lastTile = { x: -1, y: -1 };
      this.avatarStudioPresentation?.exit();
    }

    private renderAvatarStudio(): void {
      if (!this.avatarStudioGraphics) return;
      this.avatarStudioGraphics.clear();
      if (!this.avatarStudioActive) return;
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
      const highlighted = this.avatarStudio?.state.highlightedFigure;
      for (const figure of AVATAR_STUDIO_DEFINITION.figures) {
        let image = this.avatarStudioFigures.get(figure.figure);
        if (!image) {
          image = this.add.image(0, 0, 'player').setDepth(2).setDisplaySize(24, 24);
          image.setData('figure', figure.figure);
          this.avatarStudioFigures.set(figure.figure, image);
        }
        image
          .setVisible(true)
          .setPosition(
            ROOM_ORIGIN.x + (figure.x + 0.5) * AVATAR_STUDIO_TILE_SIZE,
            ROOM_ORIGIN.y + (figure.y + 0.5) * AVATAR_STUDIO_TILE_SIZE,
          )
          .setTint(highlighted === figure.figure ? 0xffd66b : avatarPlaceholderTint(figure.sprite));
      }
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
            })
            .setOrigin(0.5)
            .setDepth(3);
          this.roomLabels.set(station.station, label);
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
      const velocity = calculateMovementVelocity(held, this.sprinting());
      const body = this.player.body as PhaserTypes.Physics.Arcade.Body;
      body.setVelocity(velocity.x, velocity.y);
      return held;
    }

    private moveRoomPlayer(delta: number): void {
      const controller = this.activeRoomController();
      const map = this.activeRoomMap();
      if (!this.cursors || !controller || !map || controller.state.controlOwner !== 'world') return;
      const held = this.heldDirections();
      const velocity = calculateMovementVelocity(held, this.sprinting());
      if (velocity.x === 0 && velocity.y === 0) return;
      const stepX = (velocity.x * Math.max(delta, 1)) / 1000;
      const stepY = (velocity.y * Math.max(delta, 1)) / 1000;
      const nextX = this.player.x + stepX;
      const nextY = this.player.y + stepY;
      const currentTile = worldToRoomTile(this.player.x, this.player.y);
      const horizontalTile = worldToRoomTile(nextX, this.player.y);
      if (!isFixedRoomSolidAt(map, horizontalTile.x, currentTile.y)) this.player.x = nextX;
      // Recompute the vertical candidate after horizontal movement. This
      // prevents a diagonal corner from testing collision against an x tile
      // that the horizontal step was unable to enter.
      const verticalTile = worldToRoomTile(this.player.x, nextY);
      if (!isFixedRoomSolidAt(map, verticalTile.x, verticalTile.y)) this.player.y = nextY;
    }

    private moveAvatarStudioPlayer(delta: number): void {
      if (!this.cursors || !this.avatarStudio?.state.inRoom) return;
      const held = this.heldDirections();
      const velocity = calculateMovementVelocity(held, this.sprinting());
      if (velocity.x === 0 && velocity.y === 0) return;
      const stepX = (velocity.x * Math.max(delta, 1)) / 1000;
      const stepY = (velocity.y * Math.max(delta, 1)) / 1000;
      const currentTile = worldToRoomTile(this.player.x, this.player.y);
      const nextX = this.player.x + stepX;
      const horizontalTile = worldToRoomTile(nextX, this.player.y);
      if (!isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, horizontalTile.x, currentTile.y)) this.player.x = nextX;
      const nextY = this.player.y + stepY;
      const verticalTile = worldToRoomTile(this.player.x, nextY);
      if (!isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, verticalTile.x, verticalTile.y)) this.player.y = nextY;
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
      this.lastTile = tile;
      if (!this.avatarStudioActive && isAvatarStudioEntrance(this.map, tile.x, tile.y)) {
        this.avatarStudio?.enter();
        return;
      }
      this.doors.update(tile);
      onTileChanged?.(tile);
    }

    private reportAvatarStudioTile(): void {
      const tile = worldToRoomTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      this.lastTile = tile;
      this.avatarStudio?.update(tile);
    }

    private applyAvatarSprite(sprite: AvatarSpriteKey): void {
      this.player.setTint(avatarPlaceholderTint(sprite));
      this.player.setData('sprite', sprite);
    }

    private reportRoomTile(): void {
      const tile = worldToRoomTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      this.lastTile = tile;
      this.activeRoomController()?.update(tile);
    }

    private activeRoomController(): FixedRoomController | undefined {
      return this.activeRoom ? this.roomControllers?.[this.activeRoom] : undefined;
    }

    private activeRoomMap(): FixedRoomMap | undefined {
      return this.activeRoom ? this.roomMaps?.[this.activeRoom] : undefined;
    }
  };
}

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

// ---------------------------------------------------------------------------
// Placeholder art
// ---------------------------------------------------------------------------

/** Index of each tile kind within the generated tileset strip. */
export const TILE_INDEX: Record<TileKind, number> = {
  grass: 0,
  road: 1,
  pavement: 2,
  wall: 3,
  facade: 4,
};

/**
 * Generate the procedural player texture. The street tiles are sourced by
 * createKenneyRuntimeTextures above; map data, collision, doors and camera
 * remain art-agnostic.
 */
function makePlayerTexture(scene: Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xf2e8c9, 1);
  graphics.fillRoundedRect(0, 0, PLAYER_SIZE, PLAYER_SIZE, 4);
  graphics.fillStyle(0x2b2b33, 1);
  graphics.fillRect(5, 7, 4, 4);
  graphics.fillRect(PLAYER_SIZE - 9, 7, 4, 4);
  graphics.generateTexture('player', PLAYER_SIZE, PLAYER_SIZE);

  graphics.destroy();
}
