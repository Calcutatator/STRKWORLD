import type { AvatarSpriteKey, EventBus, WorldEvents } from '@strkworld/shared';
import { avatarSpriteForFigure } from './avatar-state.js';
import type { AvatarOutfitSelection } from './avatar-outfit.js';

export const AVATAR_STUDIO_TILE_SIZE = 32;
/**
 * D-134: the Garden. The old 18 by 12 dressing room is a walled garden of
 * sixteen themed nooks, one per look, laid on a grid of lanes.
 */
export const AVATAR_STUDIO_WIDTH = 30;
export const AVATAR_STUDIO_HEIGHT = 24;

/** D-134: a nook is five tiles across and three deep, open to the south. */
export const GARDEN_NOOK_WIDTH = 5;
export const GARDEN_NOOK_DEPTH = 3;

export interface AvatarStudioRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * D-134: which vignette a nook is dressed as. One per look, chosen from that
 * look's name, outfit and weapon in `three/avatar-looks.ts`; the renderer
 * switches on it and nothing else reads it.
 */
export type GardenNookKind =
  | 'trailhead'
  | 'workshop'
  | 'fernGlade'
  | 'herbary'
  | 'scriptorium'
  | 'tinkerYard'
  | 'woodpile'
  | 'duelLawn'
  | 'whetstone'
  | 'shadowBower'
  | 'archery'
  | 'bastion'
  | 'moonCircle'
  | 'forge'
  | 'warCamp'
  | 'chapterRose';

/** D-134: the three colours a nook is planted and painted in, from its look. */
export interface GardenNookPalette {
  /** The look's dominant garment colour: the plinth's rim and its banner. */
  readonly primary: number;
  /** Its metal or trim: lantern light, tool steel, gold leaf. */
  readonly accent: number;
  /** What flowers in its beds. */
  readonly bloom: number;
}

export interface AvatarStudioFigure extends AvatarStudioRect {
  readonly figure: number;
  readonly sprite: AvatarSpriteKey;
  readonly kind: GardenNookKind;
  readonly palette: GardenNookPalette;
}

export interface AvatarStudioDefinition {
  readonly width: number;
  readonly height: number;
  readonly spawn: { readonly x: number; readonly y: number };
  readonly exit: AvatarStudioRect;
  readonly figures: readonly AvatarStudioFigure[];
}

/** One nook's figure tile, from the nook's own column and row. */
function nook(
  figure: number,
  x: number,
  y: number,
  kind: GardenNookKind,
  palette: GardenNookPalette,
): AvatarStudioFigure {
  return {
    figure,
    sprite: `avatar-${figure}` as AvatarSpriteKey,
    x,
    y,
    width: 1,
    height: 1,
    kind,
    palette,
  };
}

/** The four nook columns and the four nook rows the figures stand on. */
const NOOK_COLUMNS = [5, 11, 18, 24] as const;
const NOOK_ROWS = [4, 9, 14, 19] as const;

export const AVATAR_STUDIO_DEFINITION = freezeAvatarStudioDefinition({
  width: AVATAR_STUDIO_WIDTH,
  height: AVATAR_STUDIO_HEIGHT,
  spawn: { x: 15, y: 1 },
  exit: { x: 14, y: 0, width: 2, height: 1 },
  figures: [
    // Row one, nearest the gate: the cosy looks one to four.
    // 1 — auburn adventurer, teal scarf and tunic, leather harness.
    nook(1, NOOK_COLUMNS[0], NOOK_ROWS[0], 'trailhead', { primary: 0x2f7d74, accent: 0x8a5a2a, bloom: 0xe8b24a }),
    // 2 — orange cat-girl mechanic, olive work jacket, brass goggles.
    nook(2, NOOK_COLUMNS[1], NOOK_ROWS[0], 'workshop', { primary: 0x6a7232, accent: 0xd8821e, bloom: 0xf2a93b }),
    // 3 — teal-haired ranger, cream hood over a forest-green tunic.
    nook(3, NOOK_COLUMNS[2], NOOK_ROWS[0], 'fernGlade', { primary: 0x2f5a3a, accent: 0xe6dcc0, bloom: 0xbfd9a0 }),
    // 4 — golden-bearded elder, cream fur-trimmed coat, green tunic.
    nook(4, NOOK_COLUMNS[3], NOOK_ROWS[0], 'herbary', { primary: 0x3f6b3a, accent: 0xe4d49a, bloom: 0xc8a2d8 }),
    // Row two: the cosy looks five to eight.
    // 5 — blonde scholar, ankle-length cream-and-gold robe.
    nook(5, NOOK_COLUMNS[0], NOOK_ROWS[1], 'scriptorium', { primary: 0xf0e2b8, accent: 0xd3a73a, bloom: 0xf6f2e4 }),
    // 6 — pink double-bun mechanic, orange jumpsuit, dark teal belt.
    nook(6, NOOK_COLUMNS[1], NOOK_ROWS[1], 'tinkerYard', { primary: 0xde7f22, accent: 0x1e4a56, bloom: 0xf2a0c0 }),
    // 7 — large moss-haired woodsman, mossy cloak, fur collar.
    nook(7, NOOK_COLUMNS[2], NOOK_ROWS[1], 'woodpile', { primary: 0x4a622a, accent: 0x7a4a12, bloom: 0xd8e07a }),
    // 8 — navy duellist, navy long coat with gold trim.
    nook(8, NOOK_COLUMNS[3], NOOK_ROWS[1], 'duelLawn', { primary: 0x1f3a6e, accent: 0xd09a3a, bloom: 0x8c9ed8 }),
    // Row three: the battle looks nine to twelve.
    // 9 — the swordsman, charcoal battle coat with teal trim.
    nook(9, NOOK_COLUMNS[0], NOOK_ROWS[2], 'whetstone', { primary: 0x33363c, accent: 0x2f7d74, bloom: 0x7fb0a8 }),
    // 10 — the rogue, dark leathers and an olive cowl, a dagger.
    nook(10, NOOK_COLUMNS[1], NOOK_ROWS[2], 'shadowBower', { primary: 0x2a2a28, accent: 0x6a7232, bloom: 0x7a4a8c }),
    // 11 — the archer, moss-green hood and cape, quiver and longbow.
    nook(11, NOOK_COLUMNS[2], NOOK_ROWS[2], 'archery', { primary: 0x3d5a2c, accent: 0xd9c08a, bloom: 0xe0b04a }),
    // 12 — the guardian, steel plate with gold trim, kite shield and mace.
    nook(12, NOOK_COLUMNS[3], NOOK_ROWS[2], 'bastion', { primary: 0x8f969e, accent: 0xeab54c, bloom: 0xd8524a }),
    // Row four, the deepest: the battle looks thirteen to sixteen.
    // 13 — the mage, midnight-indigo robe, gold trim, crystal-orb staff.
    nook(13, NOOK_COLUMNS[0], NOOK_ROWS[3], 'moonCircle', { primary: 0x30336a, accent: 0xe59108, bloom: 0x6cc4e0 }),
    // 14 — the smith-warrior, steel cuirass, copper pauldrons, war hammer.
    nook(14, NOOK_COLUMNS[1], NOOK_ROWS[3], 'forge', { primary: 0x9aa1a8, accent: 0xde7f22, bloom: 0xc0662a }),
    // 15 — the berserker, horned bronze helm, bronze plate, halberd.
    nook(15, NOOK_COLUMNS[2], NOOK_ROWS[3], 'warCamp', { primary: 0xb0761a, accent: 0xe9d7a1, bloom: 0x8a9a4a }),
    // 16 — the guild knight, white gold-trimmed coat, steel plate, longsword.
    nook(16, NOOK_COLUMNS[3], NOOK_ROWS[3], 'chapterRose', { primary: 0xeceef0, accent: 0xd09a3a, bloom: 0xe2808c }),
  ],
} as const satisfies AvatarStudioDefinition);

function freezeAvatarStudioDefinition(
  definition: AvatarStudioDefinition,
): AvatarStudioDefinition {
  const figures = definition.figures.map((figure) =>
    Object.freeze({ ...figure, palette: Object.freeze({ ...figure.palette }) }),
  );
  return Object.freeze({
    width: definition.width,
    height: definition.height,
    spawn: Object.freeze({ ...definition.spawn }),
    exit: Object.freeze({ ...definition.exit }),
    figures: Object.freeze(figures),
  });
}

/**
 * D-134: the whole nook a figure stands in — five across, three deep, its
 * back row one tile north of the figure. Derived from the figure's tile so a
 * nook can never drift from the figure it belongs to.
 */
export function gardenNookRect(figure: AvatarStudioRect): AvatarStudioRect {
  return {
    x: figure.x - (GARDEN_NOOK_WIDTH - 1) / 2,
    y: figure.y - 1,
    width: GARDEN_NOOK_WIDTH,
    height: GARDEN_NOOK_DEPTH,
  };
}

/**
 * D-134: a planted tile of a nook — the back bed behind the figure and the
 * bed either side of it. Solid: the props stand on these, and the figure's
 * own tile and the lip in front of it stay walkable.
 */
export function isGardenNookBed(figure: AvatarStudioRect, x: number, y: number): boolean {
  const rect = gardenNookRect(figure);
  if (y === rect.y) return x >= rect.x && x < rect.x + rect.width;
  if (y === rect.y + 1) return x === rect.x || x === rect.x + rect.width - 1;
  return false;
}

export interface AvatarStudioState {
  readonly inRoom: boolean;
  readonly selected: AvatarSpriteKey;
  readonly highlightedFigure: number | null;
}

export interface AvatarStudioController {
  readonly state: AvatarStudioState;
  enter(): void;
  /**
   * The player's Studio tile changed: the exit leaves at once (a
   * transition); a figure in reach is only highlighted (D-117).
   */
  update(tile: { x: number; y: number }): void;
  /** D-117: E at the highlighted figure: wear its look. Returns whether the look changed. */
  activate(): boolean;
  /** D-117: the figure E would put on right now, or null (none in reach, or already worn). */
  interaction(): AvatarStudioInteraction | null;
  destroy(): void;
}

/** D-117: the figure E would put on, for the World's interaction system. */
export interface AvatarStudioInteraction {
  readonly figure: number;
  readonly sprite: AvatarSpriteKey;
  /** Its tile, in Studio tiles. */
  readonly rect: AvatarStudioRect;
}

/** D-117: the Studio's prompt, "E · WEAR". */
export const AVATAR_STUDIO_PROMPT = 'WEAR';

/**
 * D-117: the interaction target id of Studio figure `figure`. The 3D view
 * keys each figure's affordance shell by the same id (D-123), so the figure
 * the interaction system chooses is the one that glows.
 */
export function studioFigureTargetId(figure: number): string {
  return `studio:figure-${figure}`;
}

/**
 * D-117: the figure within reach of a Studio tile: the one the player
 * stands on, else one in the ring of tiles round it (the figures stand far
 * enough apart that rings never meet).
 */
export function avatarStudioFigureInReach(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): AvatarStudioFigure | null {
  const on = avatarStudioFigureAt(definition, x, y);
  if (on) return on;
  return definition.figures.find((figure) => (
    x >= figure.x - 1 && x < figure.x + figure.width + 1 &&
    y >= figure.y - 1 && y < figure.y + figure.height + 1
  )) ?? null;
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

/** Renderer-free operations the World session's presentation adapter supplies. */
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
 * renderer-facing part and is supplied by the World session; keeping this ordering
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
  let destroyPending = false;
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
      try {
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
      } catch (error) {
        // Exit is a multi-port handoff just like entry. Restore the known
        // Studio contract after a partial failure so the controller can keep
        // ownership and retry from a coherent presentation.
        if (isCurrent()) {
          restoreStudioPresentation(port, studioBounds, studioSpawn, isCurrent);
        }
        throw error;
      }
    },
    destroy(): void {
      if (destroying || (destroyed && !destroyPending)) return;
      // Retain ownership when cleanup fails so a later Scene teardown can
      // retry. Guard synchronous reentrancy while the port owns this attempt.
      destroying = true;
      destroyed = true;
      transitionRevision += 1;
      try {
        options.port.destroyStudio();
        destroyPending = false;
      } catch (error) {
        // Keep the presentation retired while retaining the failed cleanup for
        // an explicit retry. No new transition may use partial teardown state.
        destroyPending = true;
        throw error;
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

function restoreStudioPresentation(
  port: AvatarStudioPresentationPort,
  studioBounds: AvatarStudioBounds,
  studioSpawn: { readonly x: number; readonly y: number },
  isCurrent: () => boolean,
): void {
  const attempts: Array<() => void> = [
    () => port.setPlayerVelocity(0, 0),
    () => port.setBodyEnabled(false),
    () => port.setGroundVisible(false),
    () => port.setDoorsVisible(false),
    () => port.setRemoteVisible(false),
    () => port.setLabelsVisible(false),
    () => port.setRoomVisible(false),
    () => port.setStudioVisible(true),
    () => port.setWorldBounds(studioBounds),
    () => port.setCameraBounds(studioBounds),
    () => port.setPlayerPosition(studioSpawn),
  ];
  for (const attempt of attempts) {
    if (!isCurrent()) return;
    try {
      attempt();
    } catch {
      // The exit failure remains authoritative. Attempt every restoration
      // action so one faulty port does not strand another resource.
    }
  }
}

export function validateAvatarStudioDefinition(definition: AvatarStudioDefinition): void {
  if (definition.width !== AVATAR_STUDIO_WIDTH || definition.height !== AVATAR_STUDIO_HEIGHT) {
    throw new Error('The Garden must use the fixed 30x24 envelope');
  }
  if (
    !validRect(definition.exit) ||
    !insideRect(definition, definition.exit) ||
    definition.exit.width !== 2 ||
    definition.exit.height !== 1 ||
    definition.exit.x !== (definition.width - definition.exit.width) / 2 ||
    definition.exit.y !== 0
  ) {
    throw new Error('The Garden gate must be a centred two-tile top-border opening');
  }
  if (definition.figures.length !== 16) {
    throw new Error('The Garden must contain exactly sixteen figures, one per look');
  }
  const seen = new Set<number>();
  const kinds = new Set<GardenNookKind>();
  for (let index = 0; index < definition.figures.length; index += 1) {
    const figure = definition.figures[index]!;
    if (!Number.isInteger(figure.figure) || figure.figure < 1 || figure.figure > 16) {
      throw new Error('Garden figures must be numbered from 1 to 16');
    }
    if (seen.has(figure.figure) || figure.sprite !== avatarSpriteForFigure(figure.figure)) {
      throw new Error('Garden figures must each wear a different look');
    }
    if (kinds.has(figure.kind)) {
      throw new Error('Garden nooks must each be dressed as a different vignette');
    }
    if (
      !validRect(figure) ||
      figure.width !== 1 ||
      figure.height !== 1 ||
      !insideRect(definition, figure) ||
      !insideInteriorRect(definition, figure) ||
      overlaps(figure, definition.exit)
    ) {
      throw new Error(
        'Garden figures must be single in-bounds tiles off the gate, strictly inside the walkable interior',
      );
    }
    const rect = gardenNookRect(figure);
    if (!insideRect(definition, rect) || !insideInteriorRect(definition, rect)) {
      throw new Error('Garden nooks must sit strictly inside the hedge');
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (overlaps(rect, gardenNookRect(definition.figures[previous]!))) {
        throw new Error('Garden nooks must not overlap');
      }
    }
    seen.add(figure.figure);
    kinds.add(figure.kind);
  }
  if (
    !Number.isInteger(definition.spawn.x) ||
    !Number.isInteger(definition.spawn.y) ||
    definition.spawn.x <= 0 ||
    definition.spawn.y <= 0 ||
    definition.spawn.x >= definition.width - 1 ||
    definition.spawn.y >= definition.height - 1 ||
    insideRectAt(definition.exit, definition.spawn.x, definition.spawn.y) ||
    definition.figures.some(
      (figure) =>
        insideRectAt(figure, definition.spawn.x, definition.spawn.y) ||
        isGardenNookBed(figure, definition.spawn.x, definition.spawn.y),
    )
  ) {
    throw new Error(
      'The Garden spawn must be a walkable interior tile off the gate, the beds and the figures',
    );
  }
  if (
    definition.spawn.x !== definition.exit.x + Math.floor(definition.exit.width / 2) ||
    definition.spawn.y !== definition.exit.y + definition.exit.height
  ) {
    throw new Error('The Garden spawn must be immediately inside the centred gate');
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

/**
 * D-134: what one Garden tile is.
 *
 * `gate` is the opening back to the street; `hedge` is the wall round the
 * whole garden; `bed` is a nook's planted ground, where its props stand;
 * `path` is the flagged lane grid between the nooks; `lawn` is everything
 * else — the mown grass inside a nook, in front of its figure.
 */
export type GardenTileRole = 'gate' | 'hedge' | 'bed' | 'path' | 'lawn';

export function avatarStudioTileRole(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): GardenTileRole {
  if (isAvatarStudioExit(definition, x, y)) return 'gate';
  if (x === 0 || y === 0 || x === definition.width - 1 || y === definition.height - 1) {
    return 'hedge';
  }
  let inNookColumn = false;
  let inNookRow = false;
  for (const figure of definition.figures) {
    if (isGardenNookBed(figure, x, y)) return 'bed';
    const rect = gardenNookRect(figure);
    if (x >= rect.x && x < rect.x + rect.width) inNookColumn = true;
    if (y >= rect.y && y < rect.y + rect.height) inNookRow = true;
  }
  // A lane is a column or a row no nook occupies, so the lanes read as one
  // grid of flagstones and every nook opens straight onto one.
  if (inNookColumn && inNookRow) return 'lawn';
  // The lane that runs right against the hedge is a mown verge rather than
  // more flagstone, so the border planting stands in grass and the garden
  // reads green from the gate. It is walked on like any other lane; only the
  // threshold the gate opens onto stays paved.
  const againstHedge = x === 1 || y === 1 || x === definition.width - 2 || y === definition.height - 2;
  const onThreshold = y === 1 && x >= definition.exit.x && x < definition.exit.x + definition.exit.width;
  return againstHedge && !onThreshold ? 'lawn' : 'path';
}

/**
 * Figures are visual contact targets, not walls. The hedge and the nooks'
 * planted beds are the collision; everything else is walked on.
 */
export function isAvatarStudioSolidAt(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): boolean {
  if (!inside(definition, x, y)) return true;
  const role = avatarStudioTileRole(definition, x, y);
  return role === 'hedge' || role === 'bed';
}

/** Placeholder ground colour for one tile; the gate wins over the hedge. */
export function avatarStudioTileColour(
  definition: AvatarStudioDefinition,
  x: number,
  y: number,
): number {
  return GARDEN_TILE_COLOURS[avatarStudioTileRole(definition, x, y)];
}

const GARDEN_TILE_COLOURS: Readonly<Record<GardenTileRole, number>> = Object.freeze({
  gate: 0xbba066,
  hedge: 0x2f4a2c,
  bed: 0x4a3828,
  path: 0x8e8674,
  lawn: 0x4e7a3c,
});

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
  let highlightRevision = 0;
  let committedHighlightRevision = 0;

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
    try {
      publish();
    } catch (error) {
      // State publication is an external lifecycle boundary. If the outside
      // snapshot is rejected, restore Studio ownership and presentation so a
      // later exit can retry the same handoff instead of becoming a no-op.
      if (!destroyed && !inRoom) {
        inRoom = true;
        highlightedFigure = previousHighlightedFigure;
        try {
          options.onEnter?.();
        } catch {
          // Preserve the original publication error.
        }
      }
      throw error;
    }
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
      // A newer update makes an in-flight selection's snapshot stale.
      updateRevision += 1;
      if (isAvatarStudioExit(definition, tile.x, tile.y)) {
        leave();
        return;
      }
      // D-117: a figure in reach is highlighted; E puts it on (`activate`).
      const figure = avatarStudioFigureInReach(definition, tile.x, tile.y);
      const nextHighlight = figure?.figure ?? null;
      if (nextHighlight !== highlightedFigure) {
        const previousHighlight = highlightedFigure;
        const ownHighlightRevision = ++highlightRevision;
        highlightedFigure = nextHighlight;
        try {
          publish();
          // A nested failed update may have restored this candidate, while a
          // nested successful update remains the newer owner. The final
          // value is the authoritative published state when this callback
          // completes successfully.
          if (!destroyed && inRoom && highlightedFigure === nextHighlight) {
            committedHighlightRevision = Math.max(
              committedHighlightRevision,
              highlightRevision,
            );
          }
        } catch (error) {
          // Highlight delivery is an external synchronous boundary. Roll
          // back only when no newer successful highlight publication owns the
          // candidate; a nested failed update restores its own prior value and
          // lets this outer failure roll back as well.
          if (
            !destroyed &&
            inRoom &&
            highlightedFigure === nextHighlight &&
            committedHighlightRevision < ownHighlightRevision
          ) {
            highlightedFigure = previousHighlight;
          }
          throw error;
        }
      }
    },
    activate(): boolean {
      if (destroyed || !inRoom) return false;
      const figure = definition.figures.find((candidate) => candidate.figure === highlightedFigure);
      if (!figure) return false;
      const ownRevision = ++updateRevision;
      if (!options.selection.select(figure.sprite)) return false;
      // Selection delivery is synchronous and can destroy or leave the
      // Studio, or move the player on; do not publish a snapshot for a
      // retired lifecycle.
      if (destroyed || !inRoom || updateRevision !== ownRevision) return true;
      publish();
      return true;
    },
    interaction(): AvatarStudioInteraction | null {
      if (destroyed || !inRoom) return null;
      const figure = definition.figures.find((candidate) => candidate.figure === highlightedFigure);
      if (!figure || figure.sprite === options.selection.selected) return null;
      return Object.freeze({
        figure: figure.figure,
        sprite: figure.sprite,
        rect: Object.freeze({ x: figure.x, y: figure.y, width: figure.width, height: figure.height }),
      });
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
