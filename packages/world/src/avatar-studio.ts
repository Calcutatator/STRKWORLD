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

export const AVATAR_STUDIO_DEFINITION = freezeAvatarStudioDefinition({
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
} as const satisfies AvatarStudioDefinition);

function freezeAvatarStudioDefinition(
  definition: AvatarStudioDefinition,
): AvatarStudioDefinition {
  const figures = definition.figures.map((figure) => Object.freeze({ ...figure }));
  return Object.freeze({
    width: definition.width,
    height: definition.height,
    spawn: Object.freeze({ ...definition.spawn }),
    exit: Object.freeze({ ...definition.exit }),
    figures: Object.freeze(figures),
  });
}

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
  const streetBounds = Object.freeze({ ...options.streetBounds });
  const studioBounds = Object.freeze({ ...options.studioBounds });
  const studioSpawn = Object.freeze({ ...options.studioSpawn });
  const streetReturn = Object.freeze({ ...options.streetReturn });
  let destroyed = false;
  let destroying = false;
  let transitionRevision = 0;
  return {
    enter(): void {
      if (destroyed || destroying) return;
      const ownTransition = ++transitionRevision;
      const isCurrent = (): boolean =>
        !destroyed && !destroying && transitionRevision === ownTransition;
      const { port } = options;
      try {
        port.setPlayerVelocity(0, 0);
        if (!isCurrent()) return;
        port.setBodyEnabled(false);
        if (!isCurrent()) return;
        port.setGroundVisible(false);
        if (!isCurrent()) return;
        port.setDoorsVisible(false);
        if (!isCurrent()) return;
        port.setRemoteVisible(false);
        if (!isCurrent()) return;
        port.setLabelsVisible(false);
        if (!isCurrent()) return;
        port.setRoomVisible(false);
        if (!isCurrent()) return;
        port.setStudioVisible(true);
        if (!isCurrent()) return;
        port.setWorldBounds(studioBounds);
        if (!isCurrent()) return;
        port.setCameraBounds(studioBounds);
        if (!isCurrent()) return;
        port.setPlayerPosition(studioSpawn);
      } catch (error) {
        // Entry is a multi-port handoff. A later port can fail after earlier
        // calls have already hidden the street or disabled the player. Restore
        // the known street contract while preserving the original failure so a
        // controller can retry the transition without a half-entered world.
        if (isCurrent()) {
          restoreStreetPresentation(port, streetBounds, streetReturn, isCurrent);
        }
        throw error;
      }
    },
    exit(): void {
      if (destroyed || destroying) return;
      const ownTransition = ++transitionRevision;
      const isCurrent = (): boolean =>
        !destroyed && !destroying && transitionRevision === ownTransition;
      const { port } = options;
      port.setPlayerVelocity(0, 0);
      if (!isCurrent()) return;
      port.setBodyEnabled(true);
      if (!isCurrent()) return;
      port.setGroundVisible(true);
      if (!isCurrent()) return;
      port.setDoorsVisible(true);
      if (!isCurrent()) return;
      port.setRemoteVisible(true);
      if (!isCurrent()) return;
      port.setLabelsVisible(true);
      if (!isCurrent()) return;
      port.setRoomVisible(false);
      if (!isCurrent()) return;
      port.setStudioVisible(false);
      if (!isCurrent()) return;
      port.setWorldBounds(streetBounds);
      if (!isCurrent()) return;
      port.setCameraBounds(streetBounds);
      if (!isCurrent()) return;
      port.setPlayerPosition(streetReturn);
      if (!isCurrent()) return;
      port.resetDoors();
      if (!isCurrent()) return;
      port.resumeStreet(streetReturn, options.reportStreet);
    },
    destroy(): void {
      if (destroyed || destroying) return;
      // Retain ownership when cleanup fails so a later Scene teardown can
      // retry. Guard synchronous reentrancy while the port owns this attempt.
      destroying = true;
      transitionRevision += 1;
      try {
        options.port.destroyStudio();
        destroyed = true;
      } finally {
        destroying = false;
      }
    },
  };
}

function restoreStreetPresentation(
  port: AvatarStudioPresentationPort,
  streetBounds: AvatarStudioBounds,
  streetReturn: { readonly x: number; readonly y: number },
  isCurrent: () => boolean,
): void {
  const attempts: Array<() => void> = [
    () => port.setPlayerVelocity(0, 0),
    () => port.setBodyEnabled(true),
    () => port.setGroundVisible(true),
    () => port.setDoorsVisible(true),
    () => port.setRemoteVisible(true),
    () => port.setLabelsVisible(true),
    () => port.setRoomVisible(false),
    () => port.setStudioVisible(false),
    () => port.setWorldBounds(streetBounds),
    () => port.setCameraBounds(streetBounds),
    () => port.setPlayerPosition(streetReturn),
  ];
  for (const attempt of attempts) {
    if (!isCurrent()) return;
    try {
      attempt();
    } catch {
      // The entry failure remains authoritative. Attempt every restoration
      // action so one faulty port does not strand another resource.
    }
  }
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
  const inputDefinition = options.definition ?? AVATAR_STUDIO_DEFINITION;
  validateAvatarStudioDefinition(inputDefinition);
  const definition = freezeAvatarStudioDefinition(inputDefinition);
  let inRoom = false;
  let highlightedFigure: number | null = null;
  let destroyed = false;
  let destroyPending = false;
  let destroying = false;
  let updateRevision = 0;

  const state = (): AvatarStudioState => ({
    inRoom,
    selected: options.selection.selected,
    highlightedFigure,
  });
  const publish = (): void => options.onChange?.(state());

  const leave = (): void => {
    if (!inRoom) return;
    const previousHighlightedFigure = highlightedFigure;
    inRoom = false;
    highlightedFigure = null;
    try {
      options.onExit?.();
    } catch (error) {
      // Studio presentation is an external lifecycle boundary. If it fails,
      // keep this transition retryable unless the callback already retired or
      // replaced the controller's ownership synchronously.
      if (!destroyed && !inRoom) {
        inRoom = true;
        highlightedFigure = previousHighlightedFigure;
      }
      throw error;
    }
    if (destroyed || inRoom) return;
    publish();
    // Exit publication is synchronous and may retire or replace the Studio
    // before this turn resumes. Do not announce a stale exit.
    if (destroyed || inRoom) return;
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
      try {
        options.onEnter?.();
      } catch (error) {
        // Presentation entry is an external lifecycle boundary. If it fails,
        // do not leave the controller claiming a Studio it cannot operate; a
        // later explicit enter can retry the same presentation transition.
        inRoom = false;
        highlightedFigure = null;
        throw error;
      }
      if (destroyed || !inRoom) return;
      try {
        publish();
      } catch (error) {
        // State publication is an external lifecycle boundary too. If the
        // renderer rejects the entered snapshot, restore the presentation so
        // the controller remains outside and a later enter can retry cleanly.
        if (!destroyed && inRoom) {
          inRoom = false;
          highlightedFigure = null;
          try {
            options.onExit?.();
          } catch {
            // Preserve the original publication error.
          }
        }
        throw error;
      }
      // Entry publication is synchronous and may retire or replace the
      // controller before this turn resumes. Do not announce a stale entry.
      if (destroyed || !inRoom) return;
      try {
        options.out.emit('avatar-studio:entered', {});
      } catch (error) {
        // The announcement is an external lifecycle boundary too. If it
        // rejects the completed handoff, compensate the presentation and
        // leave entry retryable while preserving the announcement error.
        if (!destroyed && inRoom) {
          inRoom = false;
          highlightedFigure = null;
          try {
            options.onExit?.();
          } catch {
            // Preserve the original announcement error.
          }
        }
        throw error;
      }
    },
    update(tile): void {
      if (destroyed || !inRoom) return;
      const ownRevision = ++updateRevision;
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
      // this update resumes. It may also synchronously run a newer update;
      // do not let this stale frame select or publish over that newer state.
      if (destroyed || !inRoom || updateRevision !== ownRevision) return;
      if (figure && options.selection.select(figure.sprite)) {
        // Selection delivery is synchronous and can destroy or leave the
        // Studio; do not publish a snapshot for a retired lifecycle.
        if (destroyed || !inRoom || updateRevision !== ownRevision) return;
        publish();
      }
    },
    destroy(): void {
      if (destroying || (destroyed && !destroyPending)) return;
      destroying = true;
      destroyed = true;
      inRoom = false;
      highlightedFigure = null;
      try {
        options.onDestroy?.();
        destroyPending = false;
      } catch (error) {
        // Keep the controller retired while retaining the failed cleanup for
        // an explicit retry. Reentrant destroy calls during the callback are
        // suppressed by `destroying` and cannot recurse.
        destroyPending = true;
        throw error;
      } finally {
        destroying = false;
      }
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
