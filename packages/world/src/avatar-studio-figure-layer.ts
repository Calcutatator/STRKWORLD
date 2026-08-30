import type * as PhaserTypes from 'phaser';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_TILE_SIZE,
} from './avatar-studio.js';
import { applyAvatarVisual, resolveAvatarSheet } from './avatar-visual.js';

type Scene = Pick<PhaserTypes.Scene, 'add'>;
type Sprite = PhaserTypes.GameObjects.Sprite;

const HIGHLIGHT_SIZE = 24;
const HIGHLIGHT_COLOUR = 0xffd66b;

export interface AvatarStudioFigureLayerState {
  readonly visible: boolean;
  readonly highlightedFigure: number | null;
}

export interface AvatarStudioFigureLayer {
  sync(state: AvatarStudioFigureLayerState): void;
  destroy(): void;
}

/** World-local final-art presentation for the Studio's fixed selector geometry. */
export function createAvatarStudioFigureLayer(options: {
  readonly scene: Scene;
  readonly roomOrigin: { readonly x: number; readonly y: number };
}): AvatarStudioFigureLayer {
  const sprites = new Map<number, Sprite>();
  let highlight: PhaserTypes.GameObjects.Rectangle | undefined;
  let destroyed = false;

  try {
    for (const figure of AVATAR_STUDIO_DEFINITION.figures) {
      const sheet = resolveAvatarSheet(figure.sprite);
      const sprite = options.scene.add.sprite(
        options.roomOrigin.x + (figure.x + 0.5) * AVATAR_STUDIO_TILE_SIZE,
        options.roomOrigin.y + (figure.y + 0.5) * AVATAR_STUDIO_TILE_SIZE,
        sheet.textureKey,
        0,
      );
      sprites.set(figure.figure, sprite);
      applyAvatarVisual(sprite, {
        sprite: figure.sprite,
        facing: 'down',
        moving: false,
      });
      sprite.setData('figure', figure.figure);
      sprite.setDepth(3);
      sprite.setVisible(false);
    }
    highlight = options.scene.add.rectangle(
      0,
      0,
      HIGHLIGHT_SIZE,
      HIGHLIGHT_SIZE,
      HIGHLIGHT_COLOUR,
      1,
    );
    highlight.setDepth(2);
    highlight.setVisible(false);
  } catch (error) {
    // Construction failures must preserve the original error, but a secondary
    // teardown failure must not strand any other object created before it.
    destroyOwned(sprites.values(), highlight);
    sprites.clear();
    throw error;
  }

  const ownedHighlight = highlight;

  return {
    sync(state): void {
      if (destroyed) return;
      for (const sprite of sprites.values()) sprite.setVisible(state.visible);
      const selected = AVATAR_STUDIO_DEFINITION.figures.find(
        (figure) => figure.figure === state.highlightedFigure,
      );
      if (!state.visible || !selected) {
        ownedHighlight.setVisible(false);
        return;
      }
      ownedHighlight
        .setPosition(
          options.roomOrigin.x + (selected.x + 0.5) * AVATAR_STUDIO_TILE_SIZE,
          options.roomOrigin.y + (selected.y + 0.5) * AVATAR_STUDIO_TILE_SIZE,
        )
        .setVisible(true);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      const errors = destroyOwned(sprites.values(), ownedHighlight);
      sprites.clear();
      throwCleanupErrors(errors);
    },
  };
}

function destroyOwned(
  sprites: Iterable<Sprite>,
  highlight: PhaserTypes.GameObjects.Rectangle | undefined,
): unknown[] {
  const errors: unknown[] = [];
  for (const sprite of sprites) {
    try {
      sprite.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  if (highlight) {
    try {
      highlight.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Avatar Studio figure cleanup failed');
}
