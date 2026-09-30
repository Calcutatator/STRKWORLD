import {
  FOOTBALL_KICK_RANGE,
  PITCH_AREA,
  PITCH_FIELD,
  PITCH_GOAL,
  SANDBOX_ENTRANCE,
  type FootballSide,
  type TileRect,
} from '@strkworld/shared';
import type { TileKind } from './street.js';

/**
 * The football pitch square (D-078), as data: the road's west end, mirroring
 * the sandbox at its east end. The road runs west through a gate in the
 * square's fence onto a walkway round the field, with a stand along the north
 * side, low bleachers along the south, a floodlight in each corner and a goal
 * at each end of the field's long, east-west axis.
 *
 * Like the rest of the street it is plain tile data. The map paints it
 * (`paintPitch`), collision reads the tiles and the renderer
 * (three/pitch-builder.ts) stands every volume on a solid tile: the field and
 * the walkway are walkable, and only the furniture is not. The ball is not
 * here: it is shared state the Shell supplies (`FootballChannel`).
 */

/**
 * The gap in the square's fence, one tile east of the square: where the road
 * and both pavements run in, in line with the sandbox's gate at the other end.
 */
export const PITCH_GATE: TileRect = Object.freeze({
  x: PITCH_AREA.x + PITCH_AREA.width,
  y: SANDBOX_ENTRANCE.y,
  width: 1,
  height: SANDBOX_ENTRANCE.height,
});

/** The row line the field and both goals are centred on, in tiles. */
export const PITCH_MIDDLE_Z = PITCH_FIELD.y + PITCH_FIELD.height / 2;

/** The halfway line, in tiles. */
export const PITCH_HALFWAY_X = PITCH_FIELD.x + PITCH_FIELD.width / 2;

/** The centre spot, where every kick-off starts, in tiles. */
export const PITCH_CENTRE_SPOT = Object.freeze({ x: PITCH_HALFWAY_X, z: PITCH_MIDDLE_Z });

export type PitchFixtureKind = 'stand' | 'bleacher' | 'floodlight' | 'goal';

/** One piece of pitch furniture and the solid tiles it stands on. */
export interface PitchFixture extends TileRect {
  readonly kind: PitchFixtureKind;
  /** A goal's: the team that defends it, named for its end. */
  readonly side?: FootballSide;
}

const fixture = (value: PitchFixture): PitchFixture => Object.freeze({ ...value });

/**
 * Each goal's footing: the column of net behind its goal line, with a tile
 * either side of the mouth where the posts stand, so a post is solid from
 * behind as the net is.
 */
function goalFooting(side: FootballSide): PitchFixture {
  const half = PITCH_GOAL.width / 2;
  const x = side === 'west' ? PITCH_FIELD.x - PITCH_GOAL.depth : PITCH_FIELD.x + PITCH_FIELD.width;
  return fixture({ kind: 'goal', side, x, y: PITCH_MIDDLE_Z - half - 1, width: PITCH_GOAL.depth, height: PITCH_GOAL.width + 2 });
}

/**
 * Every fixture, all inside `PITCH_AREA`. The stand fills the north side to
 * the square's edge, so nobody stands behind it out of the camera's sight;
 * the south side, nearest the camera, holds only low bleachers either side
 * of an aisle, and the walkway runs all the way round the field.
 */
export const PITCH_FIXTURES: readonly PitchFixture[] = Object.freeze([
  fixture({ kind: 'stand', x: 4, y: 0, width: 20, height: 5 }),
  fixture({ kind: 'bleacher', x: 5, y: 25, width: 8, height: 2 }),
  fixture({ kind: 'bleacher', x: 15, y: 25, width: 8, height: 2 }),
  fixture({ kind: 'floodlight', x: 1, y: 1, width: 1, height: 1 }),
  fixture({ kind: 'floodlight', x: 26, y: 1, width: 1, height: 1 }),
  fixture({ kind: 'floodlight', x: 1, y: 26, width: 1, height: 1 }),
  fixture({ kind: 'floodlight', x: 26, y: 26, width: 1, height: 1 }),
  goalFooting('west'),
  goalFooting('east'),
]);

/** The board over the gate, facing the street as you walk in. */
export const PITCH_GATE_TEXT = 'FOOTBALL';

/** The prompt over the ball while the player is close enough to kick it. */
export const PITCH_KICK_PROMPT = 'E · KICK';

/** Shown over the pitch when a goal goes in. */
export const PITCH_GOAL_TEXT = 'GOAL!';

/** Shown over the pitch when a side reaches the winning score. */
export const PITCH_FULL_TIME_TEXT = 'FULL TIME';

/** The scoreboard's line, "WEST 0 – 0 EAST". Scores that are not whole numbers read 0. */
export function pitchScoreText(west: number, east: number): string {
  return `WEST ${wholeScore(west)} – ${wholeScore(east)} EAST`;
}

/** The FULL TIME moment's second line, "WEST WIN 5 – 3": the side that won, and the score. */
export function pitchWinnerText(west: number, east: number): string {
  const [w, e] = [wholeScore(west), wholeScore(east)];
  if (w === e) return pitchScoreText(w, e);
  return `${w > e ? 'WEST' : 'EAST'} WIN ${Math.max(w, e)} – ${Math.min(w, e)}`;
}

function wholeScore(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Pave the square, lay the field, mark every fixture solid and fence the street side, in an existing grid. */
export function paintPitch(tiles: TileKind[][]): void {
  fillTiles(tiles, PITCH_AREA, 'walkway');
  fillTiles(tiles, PITCH_FIELD, 'turf');
  for (const piece of PITCH_FIXTURES) fillTiles(tiles, piece, 'footing');
  // The fence stands one tile east of the square, open at the gate: the
  // road and both pavements already run through it there.
  const fence = { x: PITCH_GATE.x, y: PITCH_AREA.y, width: 1, height: PITCH_AREA.height };
  for (let row = fence.y; row < fence.y + fence.height; row++) {
    if (row >= PITCH_GATE.y && row < PITCH_GATE.y + PITCH_GATE.height) continue;
    fillTiles(tiles, { x: fence.x, y: row, width: 1, height: 1 }, 'railing');
  }
}

export function inPitchRect(rect: TileRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Whether a street tile lies in the pitch square. */
export function isPitchTile(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && inPitchRect(PITCH_AREA, x, y);
}

/**
 * Whether a player at `player` (World pixels) is close enough to kick a ball
 * at `ball`: the authority's own rule, so the prompt never promises a kick
 * the lobby will refuse.
 */
export function withinKickRange(
  player: { readonly x: number; readonly y: number },
  ball: { readonly x: number; readonly y: number },
  tileSize: number,
): boolean {
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.hypot(dx, dy) <= FOOTBALL_KICK_RANGE * tileSize;
}

function fillTiles(tiles: TileKind[][], rect: TileRect, kind: TileKind): void {
  for (let row = rect.y; row < rect.y + rect.height; row++) {
    for (let col = rect.x; col < rect.x + rect.width; col++) {
      if (tiles[row]?.[col] !== undefined) tiles[row]![col] = kind;
    }
  }
}
