import type * as PhaserTypes from 'phaser';

/**
 * The audited Kenney RPG Urban image is a 27×18 row-major grid. The one-pixel
 * gutters are part of the source image and must be included in frame math;
 * treating this as a 16px contiguous grid selects the wrong art after column
 * zero.
 */
export interface KenneyAtlasMetadata {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  spacing: number;
  columns: number;
  rows: number;
  scale: number;
  runtimeTileSize: number;
}

export const KENNEY_ATLAS: KenneyAtlasMetadata = {
  width: 458,
  height: 305,
  tileWidth: 16,
  tileHeight: 16,
  spacing: 1,
  columns: 27,
  rows: 18,
  scale: 2,
  runtimeTileSize: 32,
};

export const KENNEY_ATLAS_KEY = 'kenney-rpg-urban-atlas';
export const KENNEY_TILE_TEXTURE_KEY = 'tiles';
export const KENNEY_DOOR_TEXTURE_KEY = 'kenney-rpg-urban-door';

/** Vite rewrites this URL to the emitted asset; no deploy base path is assumed. */
export const KENNEY_ATLAS_URL = new URL(
  '../assets/third-party/kenney-rpg-urban/tilemap.png',
  import.meta.url,
).href;

export const KENNEY_TILE_ROLES = ['road', 'pavement', 'wall', 'facade', 'door'] as const;
export type KenneyTileRole = (typeof KENNEY_TILE_ROLES)[number];

interface KenneyRoleMapping {
  role: KenneyTileRole;
  frame: number;
}

const ROLE_MAPPINGS: Record<KenneyTileRole, KenneyRoleMapping> = {
  road: { role: 'road', frame: 468 },
  pavement: { role: 'pavement', frame: 109 },
  wall: { role: 'wall', frame: 72 },
  facade: { role: 'facade', frame: 99 },
  door: { role: 'door', frame: 284 },
};

const FRAME_COUNT = KENNEY_ATLAS.columns * KENNEY_ATLAS.rows;

/** Validate the immutable source geometry before a frame can be selected. */
export function validateKenneyAtlas(atlas: KenneyAtlasMetadata): void {
  if (!Number.isInteger(atlas.tileWidth) || atlas.tileWidth <= 0) {
    throw new Error('Kenney atlas tile width must be a positive integer');
  }
  if (!Number.isInteger(atlas.tileHeight) || atlas.tileHeight <= 0) {
    throw new Error('Kenney atlas tile height must be a positive integer');
  }
  if (!Number.isInteger(atlas.spacing) || atlas.spacing < 0) {
    throw new Error('Kenney atlas spacing must be a non-negative integer');
  }
  if (!Number.isInteger(atlas.columns) || atlas.columns <= 0) {
    throw new Error('Kenney atlas columns must be a positive integer');
  }
  if (!Number.isInteger(atlas.rows) || atlas.rows <= 0) {
    throw new Error('Kenney atlas rows must be a positive integer');
  }
  if (atlas.width !== atlas.columns * atlas.tileWidth + (atlas.columns - 1) * atlas.spacing) {
    throw new Error('Kenney atlas width does not match its grid metadata');
  }
  if (atlas.height !== atlas.rows * atlas.tileHeight + (atlas.rows - 1) * atlas.spacing) {
    throw new Error('Kenney atlas height does not match its grid metadata');
  }
  if (atlas.scale !== 2 || atlas.runtimeTileSize !== atlas.tileWidth * atlas.scale) {
    throw new Error('Kenney atlas runtime scale must be a clean 2x tile');
  }
}

validateKenneyAtlas(KENNEY_ATLAS);

/** Return the exact source rectangle for a zero-based row-major frame. */
export function atlasFrameRect(frame: number): { x: number; y: number; width: number; height: number } {
  if (!Number.isInteger(frame) || frame < 0 || frame >= FRAME_COUNT) {
    throw new Error(`Kenney atlas frame must be an integer from 0 to ${FRAME_COUNT - 1}`);
  }
  const column = frame % KENNEY_ATLAS.columns;
  const row = Math.floor(frame / KENNEY_ATLAS.columns);
  return {
    x: column * (KENNEY_ATLAS.tileWidth + KENNEY_ATLAS.spacing),
    y: row * (KENNEY_ATLAS.tileHeight + KENNEY_ATLAS.spacing),
    width: KENNEY_ATLAS.tileWidth,
    height: KENNEY_ATLAS.tileHeight,
  };
}

export interface KenneyRuntimeTile {
  role: KenneyTileRole;
  frame: number;
  rect: ReturnType<typeof atlasFrameRect>;
  runtimeWidth: number;
  runtimeHeight: number;
}

/** Resolve a reviewed role mapping without exposing arbitrary atlas frames. */
export function kenneyTileForRole(role: KenneyTileRole): KenneyRuntimeTile {
  const mapping = ROLE_MAPPINGS[role];
  if (!mapping) throw new Error(`Unsupported Kenney tile role: ${String(role)}`);
  return {
    role,
    frame: mapping.frame,
    rect: atlasFrameRect(mapping.frame),
    runtimeWidth: KENNEY_ATLAS.runtimeTileSize,
    runtimeHeight: KENNEY_ATLAS.runtimeTileSize,
  };
}

export interface KenneyRuntimeTextureOptions {
  /** Existing map indices; this adapter must not redefine collision/index contracts. */
  tileIndex: Readonly<Record<'grass' | 'road' | 'pavement' | 'wall' | 'facade', number>>;
  /** Existing procedural grass fill; Kenney has no approved grass mapping. */
  grassColour: number;
}

/**
 * Build the 32px tileset strip and a separate 32px door overlay from the
 * loaded atlas. This is image slicing, not authored/procedural geometry: the
 * only procedural pixels are the existing grass placeholder and its edge.
 */
export function createKenneyRuntimeTextures(
  scene: PhaserTypes.Scene,
  Phaser: typeof PhaserTypes,
  options: KenneyRuntimeTextureOptions,
): void {
  if (scene.textures.exists(KENNEY_TILE_TEXTURE_KEY)) return;

  const sourceTexture = scene.textures.get(KENNEY_ATLAS_KEY);
  const source = sourceTexture.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
  const tiles = scene.textures.createCanvas(
    KENNEY_TILE_TEXTURE_KEY,
    KENNEY_ATLAS.runtimeTileSize * 5,
    KENNEY_ATLAS.runtimeTileSize,
  );
  const door = scene.textures.createCanvas(
    KENNEY_DOOR_TEXTURE_KEY,
    KENNEY_ATLAS.runtimeTileSize * 2,
    KENNEY_ATLAS.runtimeTileSize,
  );
  if (!tiles || !door) throw new Error('Could not create Kenney runtime textures');

  tiles.context.imageSmoothingEnabled = false;
  tiles.context.fillStyle = `#${options.grassColour.toString(16).padStart(6, '0')}`;
  tiles.context.fillRect(
    0,
    0,
    KENNEY_ATLAS.runtimeTileSize,
    KENNEY_ATLAS.runtimeTileSize,
  );

  for (const role of ['road', 'pavement', 'wall', 'facade'] as const) {
    const tile = kenneyTileForRole(role);
    const x = options.tileIndex[role] * KENNEY_ATLAS.runtimeTileSize;
    drawScaledFrame(tiles.context, source, tile.rect, x, 0);
  }
  tiles.refresh();
  tiles.setFilter(Phaser.Textures.FilterMode.NEAREST);

  door.context.imageSmoothingEnabled = false;
  // The trigger remains two tiles wide so it is reachable and stable, while
  // the native door is one tile wide. Fill the visual surround with the
  // existing facade course to hide the walkable pavement cells at either
  // side without changing the map or collision contract.
  const surround = kenneyTileForRole('facade').rect;
  drawScaledFrame(door.context, source, surround, 0, 0);
  drawScaledFrame(door.context, source, surround, KENNEY_ATLAS.runtimeTileSize, 0);
  drawScaledFrame(
    door.context,
    source,
    kenneyTileForRole('door').rect,
    KENNEY_ATLAS.runtimeTileSize / 2,
    0,
  );
  door.refresh();
  door.setFilter(Phaser.Textures.FilterMode.NEAREST);
}

function drawScaledFrame(
  context: CanvasRenderingContext2D,
  source: HTMLImageElement | HTMLCanvasElement,
  rect: ReturnType<typeof atlasFrameRect>,
  destinationX: number,
  destinationY: number,
): void {
  context.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    destinationX,
    destinationY,
    rect.width * KENNEY_ATLAS.scale,
    rect.height * KENNEY_ATLAS.scale,
  );
}
