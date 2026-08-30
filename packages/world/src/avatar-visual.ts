import type * as PhaserTypes from 'phaser';
import type { AvatarSpriteKey, Facing } from '@strkworld/shared';
import { calculateMovementVelocity } from './movement-input.js';
import { resolveMovementFacing, type MovementInput } from './street-movement.js';
import {
  AVATAR_SPRITE_KEYS,
  DEFAULT_AVATAR_SPRITE,
  validateAvatarSprite,
} from './avatar-state.js';

export const AVATAR_SHEET_WIDTH = 320;
export const AVATAR_SHEET_HEIGHT = 256;
export const AVATAR_CELL_SIZE = 64;
export const AVATAR_CELL_COLUMNS = 5;
export const AVATAR_CELL_ROWS = 4;
export const AVATAR_FEET_X = 32;
export const AVATAR_FEET_Y = 56;
export const AVATAR_BODY_SIZE = 24;
export const AVATAR_ORIGIN_X = AVATAR_FEET_X / AVATAR_CELL_SIZE;
export const AVATAR_ORIGIN_Y = AVATAR_FEET_Y / AVATAR_CELL_SIZE;
export const AVATAR_WALK_COLUMNS = Object.freeze([0, 1, 2, 3, 4] as const);
export const AVATAR_ONE_SHEET_WIDTH = 384;
export const AVATAR_ONE_CELL_COLUMNS = 6;
export const AVATAR_ONE_WALK_COLUMNS = Object.freeze([0, 1, 2, 3, 4, 5] as const);
export const AVATAR_NORMAL_WALK_FPS = 8;
export const AVATAR_SPRINT_WALK_FPS = 12;

interface AvatarSheetGeometry {
  readonly width: number;
  readonly columns: number;
  readonly walkColumns: readonly number[];
}

const DEFAULT_AVATAR_SHEET_GEOMETRY: AvatarSheetGeometry = Object.freeze({
  width: AVATAR_SHEET_WIDTH,
  columns: AVATAR_CELL_COLUMNS,
  walkColumns: AVATAR_WALK_COLUMNS,
});

const AVATAR_ONE_SHEET_GEOMETRY: AvatarSheetGeometry = Object.freeze({
  width: AVATAR_ONE_SHEET_WIDTH,
  columns: AVATAR_ONE_CELL_COLUMNS,
  walkColumns: AVATAR_ONE_WALK_COLUMNS,
});

export const AVATAR_SPRITE_ASSET_URLS: Readonly<Record<AvatarSpriteKey, string>> =
  Object.fromEntries(
    AVATAR_SPRITE_KEYS.map((key) => [
      key,
      new URL(`../assets/player-sprites/v1/${key}.png`, import.meta.url).href,
    ]),
  ) as Record<AvatarSpriteKey, string>;

export interface AvatarVisualSheet {
  readonly sprite: AvatarSpriteKey;
  readonly textureKey: AvatarSpriteKey;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly walkColumns: readonly number[];
  readonly originX: number;
  readonly originY: number;
}

export const AVATAR_VISUAL_CATALOG: readonly AvatarVisualSheet[] = Object.freeze(
  AVATAR_SPRITE_KEYS.map((sprite) => {
    const geometry = sprite === 'avatar-1'
      ? AVATAR_ONE_SHEET_GEOMETRY
      : DEFAULT_AVATAR_SHEET_GEOMETRY;
    return Object.freeze({
      sprite,
      textureKey: sprite,
      url: AVATAR_SPRITE_ASSET_URLS[sprite],
      width: geometry.width,
      height: AVATAR_SHEET_HEIGHT,
      frameWidth: AVATAR_CELL_SIZE,
      frameHeight: AVATAR_CELL_SIZE,
      columns: geometry.columns,
      walkColumns: geometry.walkColumns,
      originX: AVATAR_ORIGIN_X,
      originY: AVATAR_ORIGIN_Y,
    });
  }),
);

export function resolveAvatarSheet(sprite: unknown): AvatarVisualSheet {
  const key = validateAvatarSprite(sprite);
  return AVATAR_VISUAL_CATALOG[AVATAR_SPRITE_KEYS.indexOf(key)]!;
}

export function preloadAvatarVisuals(
  scene: Pick<PhaserTypes.Scene, 'load' | 'textures'>,
): void {
  for (const sheet of AVATAR_VISUAL_CATALOG) {
    if (scene.textures.exists(sheet.textureKey)) continue;
    scene.load.spritesheet(sheet.textureKey, sheet.url, {
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
      startFrame: 0,
      endFrame: sheet.columns * AVATAR_CELL_ROWS - 1,
    });
  }
}

const FACING_ROW: Record<Facing, number> = { down: 0, left: 1, right: 2, up: 3 };
const AVATAR_FACINGS: readonly Facing[] = ['down', 'left', 'right', 'up'];

/** Normalize untrusted runtime pose data before it can form a frame index. */
function validateAvatarFacing(value: unknown): Facing {
  return AVATAR_FACINGS.includes(value as Facing) ? (value as Facing) : 'down';
}

export interface AvatarAnimationPlan {
  readonly key: string;
  readonly textureKey: AvatarSpriteKey;
  readonly frames: readonly number[];
  readonly frameRate: number;
}

export interface AvatarVisualPose {
  readonly sprite?: unknown;
  readonly facing: Facing;
  readonly moving: boolean;
  readonly sprinting?: boolean;
}

type AvatarVisualTarget = Pick<
  PhaserTypes.GameObjects.Sprite,
  'setTexture' | 'setOrigin' | 'setVertexRoundMode' | 'play' | 'stop' | 'setFrame' | 'setData'
>;

export function resolveAvatarAnimation(
  sprite: unknown,
  facing: Facing,
  sprinting: boolean,
): AvatarAnimationPlan {
  const sheet = resolveAvatarSheet(sprite);
  const resolvedFacing = validateAvatarFacing(facing);
  const rowOffset = FACING_ROW[resolvedFacing] * sheet.columns;
  return Object.freeze({
    key: `${sheet.sprite}:${resolvedFacing}:${sprinting ? 'sprint' : 'walk'}`,
    textureKey: sheet.textureKey,
    frames: Object.freeze(sheet.walkColumns.map((column) => rowOffset + column)),
    frameRate: sprinting ? AVATAR_SPRINT_WALK_FPS : AVATAR_NORMAL_WALK_FPS,
  });
}

export function registerAvatarAnimations(
  scene: Pick<PhaserTypes.Scene, 'anims'>,
): void {
  for (const sheet of AVATAR_VISUAL_CATALOG) {
    for (const facing of AVATAR_FACINGS) {
      for (const sprinting of [false, true]) {
        const plan = resolveAvatarAnimation(sheet.sprite, facing, sprinting);
        if (scene.anims.exists(plan.key)) continue;
        scene.anims.create({
          key: plan.key,
          frames: plan.frames.map((frame) => ({ key: plan.textureKey, frame })),
          frameRate: plan.frameRate,
          repeat: -1,
        });
      }
    }
  }
}

export function applyAvatarVisual(
  target: AvatarVisualTarget,
  pose: AvatarVisualPose,
): AvatarSpriteKey {
  const sheet = resolveAvatarSheet(pose.sprite);
  const facing = validateAvatarFacing(pose.facing);
  target.setTexture(sheet.textureKey);
  target.setOrigin(sheet.originX, sheet.originY);
  // Phaser 4's default `safeAuto` vertex mode skips rounding when the camera
  // applies its integer zoom. Pixel-art textures are nearest-filtered, but a
  // fractional world position can still land on fractional screen vertices;
  // fullAuto rounds the final transformed quad and keeps horizontal motion
  // crisp at the World camera's 2x zoom.
  target.setVertexRoundMode('fullAuto');
  if (pose.moving) {
    target.play(resolveAvatarAnimation(sheet.sprite, facing, pose.sprinting === true).key, true);
  } else {
    target.stop();
    target.setFrame(FACING_ROW[facing] * sheet.columns);
  }
  target.setData('sprite', sheet.sprite);
  target.setData('facing', facing);
  return sheet.sprite;
}

export interface AvatarVisualControllerState {
  readonly sprite: AvatarSpriteKey;
  readonly facing: Facing;
  readonly moving: boolean;
  readonly sprinting: boolean;
}

export interface AvatarVisualController {
  readonly state: AvatarVisualControllerState;
  present(pose: AvatarVisualPose): void;
  select(sprite: unknown): void;
  update(pose: Omit<AvatarVisualPose, 'sprite'>): void;
}

export function createAvatarVisualController(
  target: AvatarVisualTarget,
  initialSprite: unknown = DEFAULT_AVATAR_SPRITE,
): AvatarVisualController {
  let state: AvatarVisualControllerState = {
    sprite: validateAvatarSprite(initialSprite),
    facing: 'down',
    moving: false,
    sprinting: false,
  };
  let rendered = '';
  let presenting = false;
  let queuedState: AvatarVisualControllerState | null = null;

  const render = (nextState: AvatarVisualControllerState): void => {
    const key = `${nextState.sprite}:${nextState.facing}:${nextState.moving}:${nextState.sprinting}`;
    if (key === rendered) return;
    applyAvatarVisual(target, nextState);
    rendered = key;
  };

  const present = (pose: AvatarVisualPose): void => {
    const nextState: AvatarVisualControllerState = {
      sprite: validateAvatarSprite(pose.sprite),
      facing: validateAvatarFacing(pose.facing),
      moving: pose.moving,
      sprinting: pose.moving && pose.sprinting === true,
    };
    // Phaser setters are synchronous but can call back into the shell. Queue
    // a nested pose until the outer target mutation has completed; otherwise
    // the outer call resumes and commits stale state over the newer pose (and
    // can leave texture/frame/data from two different poses mixed together).
    if (presenting) {
      queuedState = nextState;
      return;
    }
    presenting = true;
    try {
      let candidate: AvatarVisualControllerState | null = nextState;
      while (candidate !== null) {
        queuedState = null;
        try {
          render(candidate);
          state = candidate;
        } catch (error) {
          rendered = '';
          queuedState = null;
          throw error;
        }
        candidate = queuedState;
      }
    } catch (error) {
      // A Phaser setter may partially mutate the target before throwing. The
      // logical state stays at the last successful pose, and the cache is
      // invalidated so a retry repairs the target rather than being skipped.
      throw error;
    } finally {
      presenting = false;
      queuedState = null;
    }
  };

  render(state);
  return {
    get state() {
      return Object.freeze({ ...state });
    },
    present,
    select(sprite) {
      present({ ...state, sprite });
    },
    update(pose) {
      present({ ...pose, sprite: state.sprite });
    },
  };
}

type LocalAvatarBodyTarget = Pick<PhaserTypes.Physics.Arcade.Sprite, 'body'>;

export function configureLocalAvatarBody(target: LocalAvatarBodyTarget): void {
  const body = target.body;
  if (!body || !('velocity' in body)) {
    throw new Error('Local avatar requires a dynamic Arcade body');
  }
  body.setSize(AVATAR_BODY_SIZE, AVATAR_BODY_SIZE, false);
  body.setOffset(
    AVATAR_FEET_X - AVATAR_BODY_SIZE / 2,
    AVATAR_FEET_Y - AVATAR_BODY_SIZE / 2,
  );
}

export interface LocalAvatarVisual {
  readonly state: AvatarVisualControllerState;
  select(sprite: unknown): void;
  update(input: MovementInput, sprinting: boolean): void;
}

export function createLocalAvatarVisual(
  target: AvatarVisualTarget & LocalAvatarBodyTarget,
  initialSprite: unknown = DEFAULT_AVATAR_SPRITE,
): LocalAvatarVisual {
  const visual = createAvatarVisualController(target, initialSprite);
  configureLocalAvatarBody(target);
  let facing = visual.state.facing;
  return {
    get state() {
      return visual.state;
    },
    select(sprite) {
      visual.select(sprite);
    },
    update(input, sprinting) {
      const nextFacing = resolveMovementFacing(input, facing);
      const velocity = calculateMovementVelocity(input, sprinting);
      visual.update({
        facing: nextFacing,
        moving: velocity.x !== 0 || velocity.y !== 0,
        sprinting,
      });
      // The visual controller is the commit point for the pose. Keep the
      // movement-facing accumulator aligned with it only after presentation
      // succeeds, so a Phaser setter failure cannot make a later no-input
      // retry inherit a turn that never rendered.
      facing = nextFacing;
    },
  };
}
