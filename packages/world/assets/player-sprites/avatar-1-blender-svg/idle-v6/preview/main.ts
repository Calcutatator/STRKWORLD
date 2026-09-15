import * as Phaser from 'phaser';
import { createStreetMap, TILE_SIZE, TILES, tileToWorld } from '../../../../../src/map/street.ts';
import {
  createKenneyRuntimeTextures, KENNEY_ATLAS_KEY, KENNEY_ATLAS_URL,
  KENNEY_TILE_TEXTURE_KEY, KENNEY_DOOR_TEXTURE_KEY,
} from '../../../../../src/kenney-urban.ts';
import { TILE_INDEX, doorOverlayLayout } from '../../../../../src/scenes/street-scene.ts';
import { calculateMovementVelocity, createWasdKeyMapping } from '../../../../../src/movement-input.ts';
import { resolveMovementFacing } from '../../../../../src/street-movement.ts';

const FACINGS = ['down', 'left', 'right', 'up'] as const;
type Facing = (typeof FACINGS)[number];
type Surface = 'road' | 'pavement' | 'grass';
const DENSITY = 1;
const SOURCE_CELL = 64;
const LOGICAL_CELL = 64;
const GAME_ZOOM = 2;
const SURFACE_FEET_Y: Record<Surface, number> = { road: 500, pavement: 600, grass: 696 };
const SURFACE_ANCHOR_OFFSET_X: Record<Surface, number> = { road: -136, pavement: -240, grass: -240 };
const SURFACE_LINEUP_SPACING: Record<Surface, number> = { road: 48, pavement: 72, grass: 72 };
const CONTACT_SHADOW = Object.freeze({
  color: 0x14251e,
  offsetY: -1.5,
  depth: 9,
  layers: Object.freeze([
    Object.freeze({ width: 24, height: 6, alpha: 0.055 }),
    Object.freeze({ width: 18, height: 4.5, alpha: 0.065 }),
    Object.freeze({ width: 12, height: 3, alpha: 0.085 }),
  ]),
});
const domStatus = document.querySelector<HTMLElement>('#status')!;
const host = document.querySelector<HTMLElement>('#game')!;
const engineErrors: string[] = [];
const textureKey = (facing: Facing) => `avatar-v6-${facing}`;
let scene: DraftScene;
let metadata: any;

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  engineErrors.push(message);
  domStatus.textContent = `Preview unavailable: ${message}`;
  console.error(error);
}

function selected(selector: string, attribute: string, current: string | null) {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
    button.setAttribute('aria-pressed', String(button.getAttribute(attribute) === current));
  });
}

class DraftScene extends Phaser.Scene {
  map = createStreetMap();
  player!: Phaser.Physics.Arcade.Sprite;
  playerShadow!: Phaser.GameObjects.Graphics;
  figures = new Map<Facing, Phaser.GameObjects.Image>();
  figureShadows = new Map<Facing, Phaser.GameObjects.Graphics>();
  labels = new Map<Facing, Phaser.GameObjects.Text>();
  cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
  facing: Facing = 'down';
  surface: Surface = 'road';
  lineup = true;
  ready = false;
  spawn = tileToWorld(this.map.spawn.x, this.map.spawn.y);
  // Road figures fit between the building approaches; grass figures remain
  // west of the central southbound path. The authored town stays unchanged.
  get comparisonX() { return this.spawn.x + SURFACE_ANCHOR_OFFSET_X[this.surface]; }

  constructor() { super({ key: 'avatar-v6-draft' }); }

  preload() {
    this.load.image(KENNEY_ATLAS_KEY, KENNEY_ATLAS_URL);
    for (const facing of FACINGS) this.load.image(textureKey(facing), metadata.frames[facing].url);
    this.load.on('loaderror', (file: { key: string }) => fail(`Could not load ${file.key}`));
  }

  create() {
    try {
      createKenneyRuntimeTextures(this, Phaser, { tileIndex: TILE_INDEX, grassColour: TILES.grass.colour });
      for (const facing of FACINGS) {
        const texture = this.textures.get(textureKey(facing));
        if (texture.source[0]?.width !== SOURCE_CELL || texture.source[0]?.height !== SOURCE_CELL) {
          throw new Error(`${facing} must be a ${SOURCE_CELL}×${SOURCE_CELL} cell.`);
        }
        // The native 64px sprite and the audited town textures both use
        // nearest sampling. UI labels keep their separate smooth sampling.
        texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
      const tilemap = this.make.tilemap({
        data: this.map.tiles.map((row) => row.map((kind) => TILE_INDEX[kind])),
        tileWidth: TILE_SIZE, tileHeight: TILE_SIZE,
      });
      const tileset = tilemap.addTilesetImage(KENNEY_TILE_TEXTURE_KEY, KENNEY_TILE_TEXTURE_KEY, TILE_SIZE, TILE_SIZE, 0, 0);
      if (!tileset) throw new Error('The actual street tileset could not be created.');
      const ground = tilemap.createLayer(0, tileset, 0, 0);
      if (!ground) throw new Error('The actual street tilemap could not be created.');
      ground.setDepth(0);
      ground.setCollision(Object.values(TILES).filter((tile) => tile.solid).map((tile) => TILE_INDEX[tile.kind]));
      for (const door of this.map.doors) {
        const layout = doorOverlayLayout(door);
        this.add.image(layout.x, layout.y, KENNEY_DOOR_TEXTURE_KEY).setDisplaySize(layout.width, layout.height).setDepth(1);
      }
      for (const label of this.map.exteriorLabels) {
        this.add.text(label.x * TILE_SIZE, label.y * TILE_SIZE, label.text, {
          color: '#f4e9c9', fontFamily: 'monospace', fontSize: '10px', align: 'center',
          stroke: '#3c312c', strokeThickness: 2,
        }).setOrigin(0.5).setDepth(2);
      }

      this.physics.world.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE);
      this.player = this.physics.add.sprite(this.comparisonX, SURFACE_FEET_Y.road, textureKey('down'));
      this.playerShadow = this.createContactShadow();
      this.player.setOrigin(0.5, 0.875).setScale(1 / DENSITY).setDepth(10).setCollideWorldBounds(true);
      if (this.player.displayWidth !== LOGICAL_CELL || this.player.displayHeight !== LOGICAL_CELL) throw new Error('The avatar logical cell has changed.');
      this.player.setVertexRoundMode('fullAuto');
      const body = this.player.body as Phaser.Physics.Arcade.Body;
      body.setSize(24 * DENSITY, 24 * DENSITY, false);
      body.setOffset(20 * DENSITY, 44 * DENSITY);
      body.updateFromGameObject();
      this.physics.add.collider(this.player, ground);
      if (body.width !== 24 || body.height !== 24 || body.center.x !== this.player.x || body.center.y !== this.player.y) {
        throw new Error('The draft avatar body is not the required 24×24 world units centered on the feet.');
      }

      FACINGS.forEach((facing) => {
        this.figures.set(facing, this.add.image(0, 0, textureKey(facing)).setOrigin(0.5, 0.875).setScale(1 / DENSITY).setDepth(10).setVertexRoundMode('fullAuto'));
        this.figureShadows.set(facing, this.createContactShadow());
        const label = this.add.text(0, 0, { down: 'FRONT', left: 'LEFT', right: 'RIGHT', up: 'BACK' }[facing], {
          color: '#f7f1d8', fontSize: '7px', fontFamily: 'monospace',
          stroke: '#26312b', strokeThickness: 0.75,
        }).setResolution(4).setOrigin(0.5, 0).setDepth(11);
        label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
        this.labels.set(facing, label);
      });
      // Arcade synchronizes the Sprite from its Body during post-update. Run
      // after that synchronization so the contact shadow has no frame of lag.
      this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.syncPlayerShadow, this);
      this.cameras.main.setBounds(0, 0, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE).setZoom(GAME_ZOOM);
      this.cameras.main.roundPixels = true;
      const keyboard = this.input.keyboard;
      if (!keyboard) throw new Error('Keyboard input is unavailable.');
      this.cursors = keyboard.createCursorKeys();
      this.wasd = keyboard.addKeys(createWasdKeyMapping(Phaser.Input.Keyboard.KeyCodes)) as typeof this.wasd;
      this.setSurface('road');
      this.ready = true;
      this.updateStatus();
      window.dispatchEvent(new CustomEvent('avatar-draft-ready'));
    } catch (error) { fail(error); }
  }

  createContactShadow() {
    const shadow = this.add.graphics().setDepth(CONTACT_SHADOW.depth);
    for (const layer of CONTACT_SHADOW.layers) {
      shadow.fillStyle(CONTACT_SHADOW.color, layer.alpha);
      shadow.fillEllipse(0, 0, layer.width, layer.height);
    }
    return shadow;
  }

  syncPlayerShadow() {
    this.playerShadow.setPosition(this.player.x, this.player.y + CONTACT_SHADOW.offsetY).setVisible(!this.lineup);
  }

  setFacing(facing: Facing) {
    if (!FACINGS.includes(facing)) throw new Error('Unknown facing.');
    this.facing = facing;
    this.player.setTexture(textureKey(facing));
    this.setLineup(false);
    selected('[data-facing]', 'data-facing', facing);
    this.updateStatus();
  }

  setLineup(enabled: boolean) {
    this.lineup = enabled;
    this.player.setVisible(!enabled);
    this.syncPlayerShadow();
    this.figures.forEach((figure) => figure.setVisible(enabled));
    this.figureShadows.forEach((shadow) => shadow.setVisible(enabled));
    this.labels.forEach((label) => label.setVisible(enabled));
    document.querySelector('#lineup')!.setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      selected('[data-facing]', 'data-facing', null);
      this.player.setVelocity(0, 0);
      this.cameras.main.stopFollow();
      this.positionLineup();
    } else {
      this.cameras.main.startFollow(this.player, true, 1, 0.12);
      this.cameras.main.centerOn(this.player.x, this.player.y - 16);
    }
    this.updateStatus();
  }

  positionLineup() {
    // Keep all four complete logical cells visible. The spacing adapts to the
    // inspected zoom, while each figure's actual world dimensions never change.
    const spacing = this.cameras.main.zoom === GAME_ZOOM ? SURFACE_LINEUP_SPACING[this.surface] : 48;
    FACINGS.forEach((facing, index) => {
      const x = this.comparisonX + (index - 1.5) * spacing;
      this.figures.get(facing)!.setPosition(x, SURFACE_FEET_Y[this.surface]);
      this.figureShadows.get(facing)!.setPosition(x, SURFACE_FEET_Y[this.surface] + CONTACT_SHADOW.offsetY);
      this.labels.get(facing)!.setPosition(x, SURFACE_FEET_Y[this.surface] + 10);
    });
    this.cameras.main.centerOn(this.comparisonX, SURFACE_FEET_Y[this.surface] - 16);
  }

  setSurface(surface: Surface) {
    if (!(surface in SURFACE_FEET_Y)) throw new Error('Unknown town surface.');
    this.surface = surface;
    this.player.setPosition(this.comparisonX, SURFACE_FEET_Y[surface]).setVelocity(0, 0);
    (this.player.body as Phaser.Physics.Arcade.Body).reset(this.player.x, this.player.y);
    this.syncPlayerShadow();
    if (this.lineup) this.setLineup(true);
    else this.cameras.main.centerOn(this.player.x, this.player.y - 16);
    selected('[data-surface]', 'data-surface', surface);
    this.updateStatus();
  }

  setZoom(zoom: number) {
    if (zoom !== GAME_ZOOM && zoom !== 4) throw new Error('Only game size (2) or marked close-up (4) is supported.');
    this.cameras.main.setZoom(zoom);
    if (this.lineup) this.positionLineup();
    selected('[data-zoom]', 'data-zoom', String(zoom));
    this.updateStatus();
  }

  updateStatus() {
    if (!this.ready) return;
    const zoom = this.cameras.main.zoom;
    domStatus.textContent = `${zoom === GAME_ZOOM ? 'Actual game size' : 'Close-up'} · ${this.lineup ? 'Four facings' : this.facing} · ${this.surface}`;
    const evidence = document.querySelector('#evidence');
    if (evidence) evidence.textContent = JSON.stringify(inspectionEvidence(), null, 2);
  }

  override update() {
    if (!this.ready) return;
    const held = {
      left: this.cursors.left.isDown || this.wasd.left.isDown,
      right: this.cursors.right.isDown || this.wasd.right.isDown,
      up: this.cursors.up.isDown || this.wasd.up.isDown,
      down: this.cursors.down.isDown || this.wasd.down.isDown,
    };
    const velocity = calculateMovementVelocity(held, this.cursors.shift.isDown);
    if (velocity.x || velocity.y) {
      if (this.lineup) this.setLineup(false);
      const facing = resolveMovementFacing(held, this.facing);
      if (facing !== this.facing) this.setFacing(facing);
    }
    this.player.setVelocity(velocity.x, velocity.y);
  }
}

function inspectionEvidence() {
  if (!scene?.ready) return { ready: false, errors: [...engineErrors] };
  const canvas = scene.game.canvas;
  const css = canvas.getBoundingClientRect();
  const camera = scene.cameras.main;
  const player = scene.player;
  const body = player.body as Phaser.Physics.Arcade.Body;
  body.updateFromGameObject();
  return {
    ready: true, stage: metadata.authoringStage, readyForReview: metadata.readyForReview, reviewStatus: metadata.reviewStatus, inspectedAt: new Date().toISOString(),
    previewKind: 'isolated-actual-Phaser-street-draft', canonicalLiveGameAcceptance: false,
    location: location.href, phaserVersion: Phaser.VERSION, renderer: scene.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas',
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    canvas: { backingWidth: canvas.width, backingHeight: canvas.height, cssWidth: css.width, cssHeight: css.height, backingToCssX: canvas.width / css.width, backingToCssY: canvas.height / css.height },
    camera: { zoom: camera.zoom, actualGameZoom: GAME_ZOOM, scrollX: camera.scrollX, scrollY: camera.scrollY, roundPixels: camera.roundPixels },
    avatar: { facing: scene.facing, lineup: scene.lineup, surface: scene.surface, sourceDensity: DENSITY, filterName: 'NEAREST', binaryAlphaRequired: true, opaquePaletteLimit: 32, sourceCell: [SOURCE_CELL, SOURCE_CELL], logicalCell: [player.displayWidth, player.displayHeight], cssCell: [player.displayWidth * camera.zoom * css.width / canvas.width, player.displayHeight * camera.zoom * css.height / canvas.height], scale: [player.scaleX, player.scaleY], origin: [player.originX, player.originY], sourceFeet: [32, 56], logicalFeet: [32, 56], position: [player.x, player.y], physicsSourceSize: [body.sourceWidth, body.sourceHeight], physicsSourceOffset: [body.offset.x, body.offset.y], physicsWorldSize: [body.width, body.height], physicsCenter: [body.center.x, body.center.y], filters: Object.fromEntries(FACINGS.map((facing) => [facing, scene.textures.get(textureKey(facing)).source[0]!.scaleMode])) },
    town: { mapName: scene.map.name, mapDimensions: [scene.map.width, scene.map.height], tileSize: TILE_SIZE, textureFilters: { tiles: scene.textures.get(KENNEY_TILE_TEXTURE_KEY).source[0]!.scaleMode, doors: scene.textures.get(KENNEY_DOOR_TEXTURE_KEY).source[0]!.scaleMode }, sources: metadata.townSources },
    presentation: {
      comparisonAnchorX: scene.comparisonX,
      comparisonAnchorsWorldX: Object.fromEntries((['road', 'pavement', 'grass'] as const).map((surface) => [surface, scene.spawn.x + SURFACE_ANCHOR_OFFSET_X[surface]])),
      gameSizeLineupSpacingWorld: SURFACE_LINEUP_SPACING,
      currentLineupSpacingWorld: camera.zoom === GAME_ZOOM ? SURFACE_LINEUP_SPACING[scene.surface] : 48,
      contactShadow: {
        kind: 'three-concentric-Phaser-ellipses', bakedIntoSprite: false,
        color: `#${CONTACT_SHADOW.color.toString(16).padStart(6, '0')}`,
        offsetWorld: [0, CONTACT_SHADOW.offsetY], depth: CONTACT_SHADOW.depth,
        layersWorld: CONTACT_SHADOW.layers,
        playerVisible: scene.playerShadow.visible,
        playerPosition: [scene.playerShadow.x, scene.playerShadow.y],
        lineup: Object.fromEntries(FACINGS.map((facing) => {
          const shadow = scene.figureShadows.get(facing)!;
          return [facing, { visible: shadow.visible, position: [shadow.x, shadow.y] }];
        })),
      },
      facingLabels: { fontSizeWorld: 7, resolution: 4, strokeWidthWorld: 0.75,
        textureFilters: Object.fromEntries(FACINGS.map((facing) => [facing, scene.labels.get(facing)!.texture.source[0]!.scaleMode])),
      },
    },
    repositoryRoot: metadata.repositoryRoot, worktree: metadata.worktree, references: metadata.references, sourceFrames: metadata.frames, authoringSources: metadata.authoringSources, reviewDecision: metadata.reviewDecision, previewSources: metadata.previewSources, errors: [...engineErrors],
  };
}

function showReferences() {
  for (const role of ['style', 'concept'] as const) {
    const reference = metadata.references[role];
    document.querySelector<HTMLImageElement>(`[data-reference="${role}"]`)!.src = reference.url;
    document.querySelector<HTMLAnchorElement>(`[data-reference-link="${role}"]`)!.href = reference.url;
  }
}

function showReviewState() {
  const ready = metadata.readyForReview === true;
  document.querySelector('.draft-label')!.textContent = ready ? 'Idle review · v6' : 'Internal refinement · v6';
  document.querySelector('#review-context')!.textContent = ready
    ? 'The four game idles are the review candidate. The references explain the visual direction.'
    : 'Internal draft for visual inspection. These four idles have not been approved.';
}

function showWithdrawnDesign() {
  document.title = 'Avatar 1 · Idle draft withdrawn';
  document.querySelector('h1')!.textContent = 'Idle draft withdrawn';
  document.querySelector('.draft-label')!.textContent = 'v6 withdrawn';
  document.querySelector('nav')!.hidden = true;
  document.querySelector('footer')!.hidden = true;
  document.querySelector('details')!.hidden = true;
  document.querySelector('#review-context')!.textContent = 'This revision is rejected or withdrawn. No replacement idles are awaiting approval.';
  host.classList.add('design-correction');
  host.setAttribute('aria-label', 'Withdrawn idle revision');
  host.removeAttribute('tabindex');
  host.innerHTML = '<p class="correction-intro">The v6 idles are withdrawn from review.</p><p>The reference direction remains visible alongside this notice. Refine a new candidate before requesting approval.</p>';
}

async function boot() {
  const response = await fetch('/__preview_meta', { cache: 'no-store' });
  metadata = await response.json();
  if (!response.ok) throw new Error(metadata.error || 'Could not read draft provenance.');
  showReferences();
  showReviewState();
  if (metadata.reviewStatus === 'rejected' || metadata.reviewStatus?.startsWith('withdrawn')) {
    showWithdrawnDesign();
    return;
  }
  const missing = FACINGS.filter((facing) => !metadata.frames[facing]?.present);
  if (missing.length) throw new Error(`Draft frames still being authored: ${missing.join(', ')}.`);
  scene = new DraftScene();
  new Phaser.Game({
    type: Phaser.WEBGL, parent: host, pixelArt: true, backgroundColor: '#4a7c3f',
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    physics: { default: 'arcade', arcade: { debug: false } },
    render: { preserveDrawingBuffer: true }, audio: { noAudio: true },
    scene: [scene], banner: false,
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-facing]').forEach((button) => button.addEventListener('click', () => scene?.ready && scene.setFacing(button.dataset.facing as Facing)));
document.querySelectorAll<HTMLButtonElement>('[data-surface]').forEach((button) => button.addEventListener('click', () => scene?.ready && scene.setSurface(button.dataset.surface as Surface)));
document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((button) => button.addEventListener('click', () => scene?.ready && scene.setZoom(Number(button.dataset.zoom))));
document.querySelector('#lineup')!.addEventListener('click', () => scene?.ready && scene.setLineup(true));
host.addEventListener('pointerdown', () => host.focus());
window.addEventListener('resize', () => setTimeout(() => scene?.updateStatus(), 100));
(window as any).avatarDraft = {
  get ready() { return scene?.ready === true; },
  evidence: inspectionEvidence,
  setFacing: (facing: Facing) => scene.setFacing(facing),
  setSurface: (surface: Surface) => scene.setSurface(surface),
  setZoom: (zoom: number) => scene.setZoom(zoom),
  setLineup: (enabled: boolean) => scene.setLineup(enabled),
};
boot().catch(fail);
