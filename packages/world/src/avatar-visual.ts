import type * as PhaserTypes from 'phaser';
import type { AvatarSpriteKey, Facing } from '@strkworld/shared';
import { calculateMovementVelocity } from './movement-input.js';
import { resolveMovementFacing, type MovementInput } from './street-movement.js';
import {
  AVATAR_SPRITE_KEYS,
  DEFAULT_AVATAR_SPRITE,
  validateAvatarSprite,
} from './avatar-state.js';

export const AVATAR_SHEET_WIDTH = 192;
export const AVATAR_SHEET_HEIGHT = 256;
export const AVATAR_CELL_SIZE = 64;
export const AVATAR_CELL_COLUMNS = 3;
export const AVATAR_CELL_ROWS = 4;
export const AVATAR_FEET_X = 32;
export const AVATAR_FEET_Y = 56;
export const AVATAR_BODY_SIZE = 24;
export const AVATAR_ORIGIN_X = AVATAR_FEET_X / AVATAR_CELL_SIZE;
export const AVATAR_ORIGIN_Y = AVATAR_FEET_Y / AVATAR_CELL_SIZE;
export const AVATAR_WALK_COLUMNS = [0, 1, 0, 2] as const;
export const AVATAR_NORMAL_WALK_FPS = 8;
export const AVATAR_SPRINT_WALK_FPS = 12;

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
  readonly originX: number;
  readonly originY: number;
}

export const AVATAR_VISUAL_CATALOG: readonly AvatarVisualSheet[] = Object.freeze(
  AVATAR_SPRITE_KEYS.map((sprite) => Object.freeze({
    sprite,
    textureKey: sprite,
    url: AVATAR_SPRITE_ASSET_URLS[sprite],
    width: AVATAR_SHEET_WIDTH,
    height: AVATAR_SHEET_HEIGHT,
    frameWidth: AVATAR_CELL_SIZE,
    frameHeight: AVATAR_CELL_SIZE,
    originX: AVATAR_ORIGIN_X,
    originY: AVATAR_ORIGIN_Y,
  })),
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
      endFrame: AVATAR_CELL_COLUMNS * AVATAR_CELL_ROWS - 1,
    });
  }
}

const FACING_ROW: Record<Facing, number> = { down: 0, left: 1, right: 2, up: 3 };
const AVATAR_FACINGS: readonly Facing[] = ['down', 'left', 'right', 'up'];

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
  'setTexture' | 'setOrigin' | 'play' | 'stop' | 'setFrame' | 'setData'
>;

export function resolveAvatarAnimation(
  sprite: unknown,
  facing: Facing,
  sprinting: boolean,
): AvatarAnimationPlan {
  const sheet = resolveAvatarSheet(sprite);
  const rowOffset = FACING_ROW[facing] * AVATAR_CELL_COLUMNS;
  return Object.freeze({
    key: `${sheet.sprite}:${facing}:${sprinting ? 'sprint' : 'walk'}`,
    textureKey: sheet.textureKey,
    frames: Object.freeze(AVATAR_WALK_COLUMNS.map((column) => rowOffset + column)),
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
  target.setTexture(sheet.textureKey);
  target.setOrigin(sheet.originX, sheet.originY);
  if (pose.moving) {
    target.play(resolveAvatarAnimation(sheet.sprite, pose.facing, pose.sprinting === true).key, true);
  } else {
    target.stop();
    target.setFrame(FACING_ROW[pose.facing] * AVATAR_CELL_COLUMNS);
  }
  target.setData('sprite', sheet.sprite);
  target.setData('facing', pose.facing);
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

  const render = (): void => {
    const key = `${state.sprite}:${state.facing}:${state.moving}:${state.sprinting}`;
    if (key === rendered) return;
    applyAvatarVisual(target, state);
    rendered = key;
  };

  const present = (pose: AvatarVisualPose): void => {
    state = {
      sprite: validateAvatarSprite(pose.sprite),
      facing: pose.facing,
      moving: pose.moving,
      sprinting: pose.moving && pose.sprinting === true,
    };
    render();
  };

  render();
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
      facing = resolveMovementFacing(input, facing);
      const velocity = calculateMovementVelocity(input, sprinting);
      visual.update({
        facing,
        moving: velocity.x !== 0 || velocity.y !== 0,
        sprinting,
      });
    },
  };
}
