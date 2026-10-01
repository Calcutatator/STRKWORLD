/**
 * Presence areas (D-087): which shared space a live session is in, and what
 * a position there may be.
 *
 * Pure functions over `@strkworld/shared`'s area grids. Nothing here imports
 * Colyseus, so the rules are unit-testable without a transport.
 *
 * The street keeps its existing rule: any finite coordinate, rounded and
 * clamped to the world (see `normalizeCoordinate`). The two shared rooms are
 * small, closed grids, so the server holds them to their walkable tiles: a
 * placement must land on one, and a move must land on one without crossing a
 * solid tile on the way. A position the rules refuse is refused whole, never
 * repaired — a position that is almost right is still somewhere the player is
 * not.
 */

import {
  PRESENCE_AREAS,
  ROOF_PRESENCE_GRID,
  STUDIO_PRESENCE_GRID,
  type Position,
  type PresenceArea,
  type PresenceAreaGrid,
} from '@strkworld/shared';

/** A shared room: every area but the street. */
export type SharedPresenceArea = Exclude<PresenceArea, 'street'>;

/** The walkable grid of each shared room. */
export const SHARED_AREA_GRIDS: Readonly<Record<SharedPresenceArea, PresenceAreaGrid>> = Object.freeze({
  roof: ROOF_PRESENCE_GRID,
  studio: STUDIO_PRESENCE_GRID,
});

/**
 * How far a move may travel without its path being checked, in World pixels:
 * one tile. A real client moves axis by axis around a corner, but two of its
 * positions a patch apart can still lie either side of one, so the straight
 * line between them clips a solid tile it never entered. Within a tile that
 * is harmless — no wall in either room is thinner than a tile, so nothing can
 * be crossed — and refusing it would strand the player, whose client resends
 * the same refused position until it moves on.
 */
export const AREA_STEP_SLACK_PX = 32;

/** Path samples are at most this far apart, in World pixels: an eighth of a tile. */
const PATH_SAMPLE_PX = 4;

/** Accept a requested area, or reject it outright. A missing one is the street. */
export function normalizePresenceArea(raw: unknown): PresenceArea | null {
  if (raw === undefined) return 'street';
  return PRESENCE_AREAS.includes(raw as PresenceArea) ? (raw as PresenceArea) : null;
}

/**
 * Whether a World pixel position lies anywhere on a shared room's grid,
 * walkable or not. For the roof that is the Exchange tower's street
 * footprint: no street player can legitimately stand there (it is the
 * building, and its door tile takes them inside), so a roof observer is
 * never sent a street peer from it, and any peer a roof player is drawn
 * standing over the footprint is on the roof (D-087).
 */
export function isOverAreaGrid(area: SharedPresenceArea, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const grid = SHARED_AREA_GRIDS[area];
  const tileX = Math.floor((x - grid.originX) / grid.tileSize);
  const tileY = Math.floor((y - grid.originY) / grid.tileSize);
  return tileX >= 0 && tileY >= 0 && tileX < grid.width && tileY < grid.height;
}

/** Whether a World pixel position stands on one of a shared room's walkable tiles. */
export function isAreaWalkable(area: SharedPresenceArea, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const grid = SHARED_AREA_GRIDS[area];
  const tileX = Math.floor((x - grid.originX) / grid.tileSize);
  const tileY = Math.floor((y - grid.originY) / grid.tileSize);
  for (const rect of grid.walkable) {
    if (
      tileX >= rect.x &&
      tileY >= rect.y &&
      tileX < rect.x + rect.width &&
      tileY < rect.y + rect.height
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a move from `from` to `to` is allowed in a shared room: `to` is
 * walkable, and either the step is within `AREA_STEP_SLACK_PX` or every
 * sample along the straight line between them is walkable too, so no move
 * jumps a wall.
 */
export function isAreaStepAllowed(area: SharedPresenceArea, from: Position, to: Position): boolean {
  if (!isAreaWalkable(area, to.x, to.y)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > AREA_STEP_SLACK_PX)) return true;
  const samples = Math.ceil(distance / PATH_SAMPLE_PX);
  for (let index = 1; index < samples; index += 1) {
    const t = index / samples;
    if (!isAreaWalkable(area, from.x + dx * t, from.y + dy * t)) return false;
  }
  return true;
}
