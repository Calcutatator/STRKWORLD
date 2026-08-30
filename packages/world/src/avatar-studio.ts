import type { AvatarSpriteKey, EventBus, WorldEvents } from '@strkworld/shared';
import { avatarSpriteForFigure } from './avatar-state.js';
import type { AvatarOutfitSelection } from './avatar-outfit.js';

export const AVATAR_STUDIO_TILE_SIZE = 32;
export const AVATAR_STUDIO_WIDTH = 18;
export const AVATAR_STUDIO_HEIGHT = 12;

export interface AvatarStudioRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AvatarStudioFigure extends AvatarStudioRect {
  readonly figure: number;
  readonly sprite: AvatarSpriteKey;
}

export interface AvatarStudioDefinition {
  readonly width: number;
  readonly height: number;
  readonly spawn: { readonly x: number; readonly y: number };
  readonly exit: AvatarStudioRect;
  readonly figures: readonly AvatarStudioFigure[];
}

export const AVATAR_STUDIO_DEFINITION = {
  width: AVATAR_STUDIO_WIDTH,
  height: AVATAR_STUDIO_HEIGHT,
  spawn: { x: 9, y: 1 },
  exit: { x: 8, y: 0, width: 2, height: 1 },
  figures: [
    { figure: 1, sprite: 'avatar-1', x: 2, y: 3, width: 1, height: 1 },
    { figure: 2, sprite: 'avatar-2', x: 5, y: 3, width: 1, height: 1 },
    { figure: 3, sprite: 'avatar-3', x: 8, y: 3, width: 1, height: 1 },
    { figure: 4, sprite: 'avatar-4', x: 11, y: 3, width: 1, height: 1 },
    { figure: 5, sprite: 'avatar-5', x: 14, y: 3, width: 1, height: 1 },
    { figure: 6, sprite: 'avatar-6', x: 4, y: 6, width: 1, height: 1 },
    { figure: 7, sprite: 'avatar-7', x: 9, y: 6, width: 1, height: 1 },
    { figure: 8, sprite: 'avatar-8', x: 14, y: 6, width: 1, height: 1 },
  ],
} as const satisfies AvatarStudioDefinition;

export interface AvatarStudioState {
  readonly inRoom: boolean;
  readonly selected: AvatarSpriteKey;
  readonly highlightedFigure: number | null;
}

export interface AvatarStudioController {
  readonly state: AvatarStudioState;
  enter(): void;
  update(tile: { x: number; y: number }): void;
  destroy(): void;
}

export interface AvatarStudioControllerOptions {
  readonly definition?: AvatarStudioDefinition;
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  /**
   * The Scene's outfit selection (D-053). Required, and deliberately not
   * defaulted: a Studio that quietly created its own copy would diverge from
   * the local avatar the moment F was pressed anywhere else.
   */
  readonly selection: AvatarOutfitSelection;
  readonly onEnter?: () => void;
  readonly onExit?: () => void;
  readonly onChange?: (state: AvatarStudioState) => void;
  /** Teardown presentation objects without emitting a late world event. */
  readonly onDestroy?: () => void;
}

export interface AvatarStudioBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Phaser-free operations owned by the StreetScene presentation adapter. */
export interface AvatarStudioPresentationPort {
  setPlayerVelocity(x: number, y: number): void;
  setBodyEnabled(enabled: boolean): void;
  setGroundVisible(visible: boolean): void;
  setDoorsVisible(visible: boolean): void;
  setRemoteVisible(visible: boolean): void;
  setLabelsVisible(visible: boolean): void;
  setRoomVisible(visible: boolean): void;
  setStudioVisible(visible: boolean): void;
  setWorldBounds(bounds: AvatarStudioBounds): void;
  setCameraBounds(bounds: AvatarStudioBounds): void;
  setPlayerPosition(position: { x: number; y: number }): void;
  resetDoors(): void;
  resumeStreet(position: { x: number; y: number }, report: () => void): void;
  destroyStudio(): void;
}

export interface AvatarStudioPresentation {
  enter(): void;
  exit(): void;
  destroy(): void;
}

/**
 * Shared lifecycle sequencing for the hidden room. The port is the only
 * Phaser-facing part and is supplied by StreetScene; keeping this ordering
 * here makes it testable without a canvas and prevents a missed restoration
 * when the room is re-entered or the scene shuts down.
 */
export function createAvatarStudioPresentation(options: {
  readonly port: AvatarStudioPresentationPort;
  readonly streetBounds: AvatarStudioBounds;
  readonly studioBounds: AvatarStudioBounds;
  readonly studioSpawn: { x: number; y: number };
  readonly streetReturn: { x: number; y: number };
  readonly reportStreet: () => void;
}): AvatarStudioPresentation {
  let destroyed = false;
  return {
    enter(): void {
      if (destroyed) return;
      const { port } = options;
      port.setPlayerVelocity(0, 0);
      if (destroyed) return;
      port.setBodyEnabled(false);
      if (destroyed) return;
      port.setGroundVisible(false);
      if (destroyed) return;
      port.setDoorsVisible(false);
      if (destroyed) return;
      port.setRemoteVisible(false);
      if (destroyed) return;
      port.setLabelsVisible(false);
      if (destroyed) return;
      port.setRoomVisible(false);
      if (destroyed) return;
      port.setStudioVisible(true);
      if (destroyed) return;
      port.setWorldBounds(options.studioBounds);
      if (destroyed) return;
      port.setCameraBounds(options.studioBounds);
      if (destroyed) return;
      port.setPlayerPosition(options.studioSpawn);
    },
    exit(): void {
      if (destroyed) return;
      const { port } = options;
      port.setPlayerVelocity(0, 0);
      if (destroyed) return;
      port.setBodyEnabled(true);
      if (destroyed) return;
      port.setGroundVisible(true);
      if (destroyed) return;
      port.setDoorsVisible(true);
      if (destroyed) return;
      port.setRemoteVisible(true);
      if (destroyed) return;
      port.setLabelsVisible(true);
      if (destroyed) return;
      port.setRoomVisible(false);
      if (destroyed) return;
      port.setStudioVisible(false);
      if (destroyed) return;
      port.setWorldBounds(options.streetBounds);
      if (destroyed) return;
      port.setCameraBounds(options.streetBounds);
      if (destroyed) return;
      port.setPlayerPosition(options.streetReturn);
      if (destroyed) return;
      port.resetDoors();
      if (destroyed) return;
      port.resumeStreet(options.streetReturn, options.reportStreet);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      options.port.destroyStudio();
    },
  };
}

export function validateAvatarStudioDefinition(definition: AvatarStudioDefinition): void {
  if (definition.width !== AVATAR_STUDIO_WIDTH || definition.height !== AVATAR_STUDIO_HEIGHT) {
    throw new Error('Avatar Studio must use the fixed 18x12 envelope');
  }
  if (
    !validRect(definition.exit) ||
    !insideRect(definition, definition.exit) ||
    definition.exit.width !== 2 ||
    definition.exit.height !== 1 ||
    definition.exit.x !== (definition.width - definition.exit.width) / 2 ||
    definition.exit.y !== 0
  ) {
    throw new Error('Avatar Studio exit must be a centred two-tile top-border opening');
  }
  if (definition.figures.length !== 8) {
    throw new Error('Avatar Studio must contain exactly eight figures');
  }
  const seen = new Set<number>();
  for (let index = 0; index < definition.figures.length; index += 1) {
    const figure = definition.figures[index]!;
    if (!Number.isInteger(figure.figure) || figure.figure < 1 || figure.figure > 8) {
      throw new Error('Avatar Studio figures must be numbered from 1 to 8');
    }
    if (seen.has(figure.figure) || figure.sprite !== avatarSpriteForFigure(figure.figure)) {
      throw new Error('Avatar Studio figures must have unique cosy states');
    }
    if (
      !validRect(figure) ||
      !insideRect(definition, figure) ||
      !insideInteriorRect(definition, figure) ||
      overlaps(figure, definition.exit)
    ) {
      throw new Error(
        'Avatar Studio figures must be in-bounds and off the exit; selectors must be strictly inside the walkable interior',
      );
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (overlaps(figure, definition.figures[previous]!)) {
        throw new Error('Avatar Studio figures must not overlap');
      }
    }
    seen.add(figure.figure);
  }
  if (
    !Number.isInteger(definition.spawn.x) ||
    !Number.isInteger(definition.spawn.y) ||
    definition.spawn.x <= 0 ||
    definition.spawn.y <= 0 ||
    definition.spawn.x >= definition.width - 1 ||
    definition.spawn.y >= definition.height - 1 ||
    insideRectAt(definition.exit, definition.spawn.x, definition.spawn.y) ||
    definition.figures.some((figure) =>
      insideRectAt(figure, definition.spawn.x, definition.spawn.y),
    )
  ) {
    throw new Error(
      'Avatar Studio spawn must be a walkable interior tile off the exit and figures',
    );
  }
  if (
    definition.spawn.x !== definition.exit.x + Math.floor(definition.exit.width / 2) ||
    definition.spawn.y !== definition.exit.y + definition.exit.height
  ) {
    throw new Error('Avatar Studio spawn must be immediately inside the centred top opening');
  }
}

/** Pixel centre of the validated interior spawn tile within the room. */
export function avatarStudioSpawnToWorld(
  definition: AvatarStudioDefinition,
  roomOrigin: { readonly x: number; readonly y: number },
  tileSize: number,
): { x: number; y: number } {
  validateAvatarStudioDefinition(definition);
  return {
    x: roomOrigin.x + definition.spawn.x * tileSize + tileSize / 2,
    y: roomOrigin.y + definition.spawn.y * tileSize + tileSize / 2,
  };
}

export function avatarStudioFigureAt(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): AvatarStudioFigure | null {
  return definition.figures.find((figure) => insideRectAt(figure, x, y)) ?? null;
}

export function isAvatarStudioExit(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): boolean {
  return insideRectAt(definition.exit, x, y);
}

/** Figures are visual contact targets, not walls; the border is the collision. */
export function isAvatarStudioSolidAt(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): boolean {
  if (!inside(definition, x, y)) return true;
  if (isAvatarStudioExit(definition, x, y)) return false;
  return x === 0 || y === 0 || x === definition.width - 1 || y === definition.height - 1;
}

/** Presentation role for one tile; the top opening wins over the border. */
export function avatarStudioTileColour(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): number {
  if (isAvatarStudioExit(definition, x, y)) return 0x8a7c62;
  if (x === 0 || y === 0 || x === definition.width - 1 || y === definition.height - 1) {
    return 0x39343b;
  }
  return 0x514c5a;
}

export function createAvatarStudioController(
  options: AvatarStudioControllerOptions,
): AvatarStudioController {
  const definition = options.definition ?? AVATAR_STUDIO_DEFINITION;
  validateAvatarStudioDefinition(definition);
  let inRoom = false;
  let highlightedFigure: number | null = null;
  let destroyed = false;

  const state = (): AvatarStudioState => ({
    inRoom,
    selected: options.selection.selected,
    highlightedFigure,
  });
  const publish = (): void => options.onChange?.(state());

  const leave = (): void => {
    if (!inRoom) return;
    inRoom = false;
    highlightedFigure = null;
    options.onExit?.();
    if (destroyed || inRoom) return;
    publish();
    options.out.emit('avatar-studio:exited', {});
  };

  return {
    get state() {
      return state();
    },
    enter(): void {
      if (destroyed || inRoom) return;
      inRoom = true;
      highlightedFigure = null;
      options.onEnter?.();
      if (destroyed || !inRoom) return;
      publish();
      options.out.emit('avatar-studio:entered', {});
    },
    update(tile): void {
      if (destroyed || !inRoom) return;
      if (isAvatarStudioExit(definition, tile.x, tile.y)) {
        leave();
        return;
      }
      const figure = avatarStudioFigureAt(definition, tile.x, tile.y);
      const nextHighlight = figure?.figure ?? null;
      if (nextHighlight !== highlightedFigure) {
        highlightedFigure = nextHighlight;
        publish();
      }
      // onChange delivery is synchronous and may destroy the Studio before
      // this update resumes; do not select or emit after that lifecycle edge.
      if (destroyed || !inRoom) return;
      if (figure && options.selection.select(figure.sprite)) publish();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      inRoom = false;
      highlightedFigure = null;
      options.onDestroy?.();
    },
  };
}

function inside(definition: AvatarStudioDefinition, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < definition.width && y < definition.height;
}

function validRect(rect: AvatarStudioRect): boolean {
  return (
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.width) &&
    Number.isInteger(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function insideRect(definition: AvatarStudioDefinition, rect: AvatarStudioRect): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= definition.width && rect.y + rect.height <= definition.height;
}

function insideInteriorRect(
  definition: AvatarStudioDefinition,
  rect: AvatarStudioRect,
): boolean {
  return (
    rect.x > 0 &&
    rect.y > 0 &&
    rect.x + rect.width < definition.width &&
    rect.y + rect.height < definition.height
  );
}

function insideRectAt(rect: AvatarStudioRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function overlaps(a: AvatarStudioRect, b: AvatarStudioRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
