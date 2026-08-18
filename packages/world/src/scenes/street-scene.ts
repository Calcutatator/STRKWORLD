import type * as PhaserTypes from 'phaser';
import type { BuildingId, EventBus, ShellEvents, StationId, WorldEvents } from '@strkworld/shared';
import {
  createStreetMap,
  isSolidAt,
  TILE_SIZE,
  TILES,
  tileToWorld,
  worldToTile,
  type DistrictMap,
  type TileKind,
} from '../map/street.js';
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
import { createRemoteAvatarLayer, type RemoteAvatarLayer } from '../remote-avatar-layer.js';
import type { RemotePeerSource } from '../remote-peer.js';

/**
 * The street.
 *
 * Placeholder art is generated at runtime from the tile colours — no external
 * asset is loaded here. That is deliberate rather than lazy: it means a
 * walkable world exists before any licence audit, and when real tiles arrive
 * they replace `makePlaceholderTextures` alone. The map data, collision and
 * door contracts do not change.
 *
 * No network I/O happens in scene lifecycle. Under any future mounting
 * regression `create()` can run twice, and a lobby join here would produce two
 * presence entries for one player. Joins are shell-driven and explicit.
 */

const PLAYER_SPEED = 160;
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
    private movement!: StreetMovementAdapter;
    private roomGraphics?: PhaserTypes.GameObjects.Graphics;
    private roomLabels = new Map<StationId, PhaserTypes.GameObjects.Text>();
    private roomStationGraphics?: PhaserTypes.GameObjects.Graphics;
    private remoteAvatars?: RemoteAvatarLayer;
    private returnTile = { x: 0, y: 0 };
    private cleanedUp = false;

    constructor() {
      super({ key: 'street' });
    }

    preload(): void {
      this.map = createStreetMap();
      makePlaceholderTextures(this, Phaser);
    }

    create(): void {
      this.drawGround();
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
      this.createCamera();
      this.createDoorTriggers();
      this.createRoomVisuals();
      this.events.once('shutdown', this.cleanShutdown, this);
    }

    override update(_time: number, delta: number): void {
      const room = this.activeRoomController();
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
      this.inputGate?.resume();
      this.roomGraphics?.destroy();
      this.roomStationGraphics?.destroy();
      for (const label of this.roomLabels.values()) label.destroy();
      this.roomLabels.clear();
      this.remoteAvatars?.destroy();
      this.remoteAvatars = undefined;
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
      const tileset = tilemap.addTilesetImage('tiles', 'tiles', TILE_SIZE, TILE_SIZE, 0, 0);
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

    private createPlayer(): void {
      const spawn = tileToWorld(this.map.spawn.x, this.map.spawn.y);
      this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player');
      this.player.setDepth(10);
      this.player.setCollideWorldBounds(true);
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
      this.wasd = keyboard.addKeys('W,A,S,D') as typeof this.wasd;
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

    private resolveBus(): { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } | undefined {
      return this.game.registry.get('bus') as
        { out: EventBus<WorldEvents>; in: EventBus<ShellEvents> } | undefined;
    }

    private createRoomVisuals(): void {
      this.roomGraphics = this.add.graphics().setDepth(1);
      this.roomStationGraphics = this.add.graphics().setDepth(2);
      this.roomGraphics.setVisible(false);
      this.roomStationGraphics.setVisible(false);
    }

    private enterRoom(definition: FixedRoomDefinition): void {
      this.player.setVelocity(0, 0);
      const body = this.player.body as PhaserTypes.Physics.Arcade.Body;
      body.setEnable(false);
      this.ground?.setVisible(false);
      this.remoteAvatars?.setVisible(false);
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
      this.remoteAvatars?.setVisible(true);
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
      const held: MovementInput = {
        left: this.cursors.left.isDown || this.wasd?.left?.isDown,
        right: this.cursors.right.isDown || this.wasd?.right?.isDown,
        up: this.cursors.up.isDown || this.wasd?.up?.isDown,
        down: this.cursors.down.isDown || this.wasd?.down?.isDown,
      };

      let vx = 0;
      let vy = 0;
      if (held.left) vx -= 1;
      if (held.right) vx += 1;
      if (held.up) vy -= 1;
      if (held.down) vy += 1;

      // Normalise so diagonals are not faster than the cardinals.
      const body = this.player.body as PhaserTypes.Physics.Arcade.Body;
      if (vx !== 0 || vy !== 0) {
        const length = Math.hypot(vx, vy);
        body.setVelocity((vx / length) * PLAYER_SPEED, (vy / length) * PLAYER_SPEED);
      } else {
        body.setVelocity(0, 0);
      }
      return held;
    }

    private moveRoomPlayer(delta: number): void {
      const controller = this.activeRoomController();
      const map = this.activeRoomMap();
      if (!this.cursors || !controller || !map || controller.state.controlOwner !== 'world') return;
      const held = this.heldDirections();
      let vx = 0;
      let vy = 0;
      if (held.left) vx -= 1;
      if (held.right) vx += 1;
      if (held.up) vy -= 1;
      if (held.down) vy += 1;
      if (vx === 0 && vy === 0) return;
      const length = Math.hypot(vx, vy);
      const step = (PLAYER_SPEED * Math.max(delta, 1)) / 1000;
      const nextX = this.player.x + (vx / length) * step;
      const nextY = this.player.y + (vy / length) * step;
      const currentTile = worldToRoomTile(this.player.x, this.player.y);
      const horizontalTile = worldToRoomTile(nextX, this.player.y);
      if (!isFixedRoomSolidAt(map, horizontalTile.x, currentTile.y)) this.player.x = nextX;
      // Recompute the vertical candidate after horizontal movement. This
      // prevents a diagonal corner from testing collision against an x tile
      // that the horizontal step was unable to enter.
      const verticalTile = worldToRoomTile(this.player.x, nextY);
      if (!isFixedRoomSolidAt(map, verticalTile.x, verticalTile.y)) this.player.y = nextY;
    }

    private heldDirections() {
      if (!this.cursors) return NO_MOVEMENT;
      return {
        left: this.cursors.left.isDown || this.wasd?.left?.isDown,
        right: this.cursors.right.isDown || this.wasd?.right?.isDown,
        up: this.cursors.up.isDown || this.wasd?.up?.isDown,
        down: this.cursors.down.isDown || this.wasd?.down?.isDown,
      };
    }

    private reportTile(): void {
      const tile = worldToTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      this.lastTile = tile;
      this.doors.update(tile);
      onTileChanged?.(tile);
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
 * Generate the tileset strip, the player, in one pass.
 *
 * The single place real artwork replaces. Everything else — map data,
 * collision, doors, camera — is art-agnostic, so swapping this out changes
 * how the world looks and nothing about how it behaves.
 */
function makePlaceholderTextures(scene: Scene, Phaser: typeof PhaserTypes): void {
  const kinds = Object.keys(TILE_INDEX) as TileKind[];
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  // One horizontal strip, one frame per kind, in TILE_INDEX order.
  for (const kind of kinds) {
    const spec = TILES[kind];
    const x = TILE_INDEX[kind] * TILE_SIZE;
    graphics.fillStyle(spec.colour, 1);
    graphics.fillRect(x, 0, TILE_SIZE, TILE_SIZE);
    // A darker edge so the grid reads as a place rather than a flat wash.
    graphics.lineStyle(1, darken(spec.colour), 0.35);
    graphics.strokeRect(x + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
  }
  graphics.generateTexture('tiles', kinds.length * TILE_SIZE, TILE_SIZE);

  graphics.clear();
  graphics.fillStyle(0xf2e8c9, 1);
  graphics.fillRoundedRect(0, 0, PLAYER_SIZE, PLAYER_SIZE, 4);
  graphics.fillStyle(0x2b2b33, 1);
  graphics.fillRect(5, 7, 4, 4);
  graphics.fillRect(PLAYER_SIZE - 9, 7, 4, 4);
  graphics.generateTexture('player', PLAYER_SIZE, PLAYER_SIZE);

  graphics.destroy();
  void Phaser;
}

function darken(colour: number): number {
  const r = Math.max(0, ((colour >> 16) & 0xff) - 40);
  const g = Math.max(0, ((colour >> 8) & 0xff) - 40);
  const b = Math.max(0, (colour & 0xff) - 40);
  return (r << 16) | (g << 8) | b;
}
