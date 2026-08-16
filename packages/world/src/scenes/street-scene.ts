import type * as PhaserTypes from 'phaser';
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

type Scene = PhaserTypes.Scene;
type Sprite = PhaserTypes.Physics.Arcade.Sprite;

export interface StreetSceneDeps {
  /** Phaser namespace, injected so this module never value-imports it. */
  Phaser: typeof PhaserTypes;
  /** Called when the player's tile changes. The scene reports; it decides nothing. */
  onTileChanged?: (tile: { x: number; y: number }) => void;
}

export function createStreetScene({ Phaser, onTileChanged }: StreetSceneDeps) {
  return class StreetScene extends Phaser.Scene {
    private map!: DistrictMap;
    // Phaser 4 can return either renderer-backed layer type from createLayer.
    private ground?: PhaserTypes.Tilemaps.TilemapLayer | PhaserTypes.Tilemaps.TilemapGPULayer;
    private player!: Sprite;
    private cursors!: PhaserTypes.Types.Input.Keyboard.CursorKeys;
    private wasd!: Record<'up' | 'down' | 'left' | 'right', PhaserTypes.Input.Keyboard.Key>;
    private lastTile = { x: -1, y: -1 };

    constructor() {
      super({ key: 'street' });
    }

    preload(): void {
      this.map = createStreetMap();
      makePlaceholderTextures(this, Phaser);
    }

    create(): void {
      this.drawGround();
      this.createPlayer();
      this.createInput();
      this.createCamera();
    }

    override update(): void {
      this.movePlayer();
      this.reportTile();
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
      this.physics.world.setBounds(
        0,
        0,
        this.map.width * TILE_SIZE,
        this.map.height * TILE_SIZE,
      );

      if (this.ground) this.physics.add.collider(this.player, this.ground);
    }

    private createInput(): void {
      const keyboard = this.input.keyboard;
      if (!keyboard) return;
      this.cursors = keyboard.createCursorKeys();
      this.wasd = keyboard.addKeys('W,A,S,D') as typeof this.wasd;
    }

    private createCamera(): void {
      const camera = this.cameras.main;
      camera.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);
      // Slight lerp so the camera feels attached rather than welded.
      camera.startFollow(this.player, true, 0.12, 0.12);
      camera.setZoom(2);
    }

    // -- per frame -----------------------------------------------------------

    private movePlayer(): void {
      if (!this.cursors) return;
      const held = {
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
    }

    private reportTile(): void {
      const tile = worldToTile(this.player.x, this.player.y);
      if (tile.x === this.lastTile.x && tile.y === this.lastTile.y) return;
      this.lastTile = tile;
      onTileChanged?.(tile);
    }
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
