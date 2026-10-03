import {
  FOOTBALL_KICK_RANGE,
  FOOTBALL_SIDE_GOAL,
  FOOTBALL_TEAM_NAMES,
  PITCH_AREA,
  PITCH_FIELD,
  PITCH_GATES,
  PITCH_GOAL,
  PITCH_PEN,
  PITCH_PEN_INTERIOR,
  SANDBOX_ENTRANCE,
  isPitchFenceTile,
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
 * behind as the net is. Which end a team keeps comes from
 * `FOOTBALL_SIDE_GOAL` (D-135) and is never guessed from the name.
 */
function goalFooting(side: FootballSide): PitchFixture {
  const half = PITCH_GOAL.width / 2;
  const x = FOOTBALL_SIDE_GOAL[side] === 'west' ? PITCH_FIELD.x - PITCH_GOAL.depth : PITCH_FIELD.x + PITCH_FIELD.width;
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
  goalFooting('starks'),
  goalFooting('snarks'),
]);

/** The board over the square's street gate, facing the street as you walk in. */
export const PITCH_GATE_TEXT = 'FOOTBALL';

/** D-135: the chip's words at a gate you may go in by. */
export const PITCH_ENTER_PROMPT = 'ENTER PITCH';

/** D-135: the chip's words at a gate you may come back out of. */
export const PITCH_LEAVE_PROMPT = 'LEAVE PITCH';

/** D-135: what a locked gate says — four real players are on, or a winner's banner is up. */
export const PITCH_LOCKED_TEXT = 'IN PLAY';

/** D-135: the "first to 3" line under the scoreboard, from the winning score. */
export function pitchTargetText(winScore: number): string {
  return `FIRST TO ${wholeScore(winScore)}`;
}

/** D-135: the winner's banner, "STARKS WIN". */
export function pitchBannerText(side: FootballSide): string {
  return `${FOOTBALL_TEAM_NAMES[side]} WIN`;
}

/** The prompt over the ball while the player is close enough to kick it. */
export const PITCH_KICK_PROMPT = 'E · KICK';

/** Shown over the pitch when a goal goes in. */
export const PITCH_GOAL_TEXT = 'GOAL!';

/** Shown over the pitch when a side reaches the winning score. */
export const PITCH_FULL_TIME_TEXT = 'FULL TIME';

/** The scoreboard's line, "STARKS 0 – 0 SNARKS". Scores that are not whole numbers read 0. */
export function pitchScoreText(starks: number, snarks: number): string {
  return `${FOOTBALL_TEAM_NAMES.starks} ${wholeScore(starks)} – ${wholeScore(snarks)} ${FOOTBALL_TEAM_NAMES.snarks}`;
}

/** The FULL TIME moment's second line, "STARKS WIN 3 – 1": the side that won, and the score. */
export function pitchWinnerText(starks: number, snarks: number): string {
  const [a, b] = [wholeScore(starks), wholeScore(snarks)];
  if (a === b) return pitchScoreText(a, b);
  return `${a > b ? FOOTBALL_TEAM_NAMES.starks : FOOTBALL_TEAM_NAMES.snarks} WIN ${Math.max(a, b)} – ${Math.min(a, b)}`;
}

function wholeScore(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Pave the square, lay the field, mark every fixture solid, fence the pitch
 * itself (D-135) and fence the street side, in an existing grid.
 */
export function paintPitch(tiles: TileKind[][]): void {
  fillTiles(tiles, PITCH_AREA, 'walkway');
  fillTiles(tiles, PITCH_FIELD, 'turf');
  for (const piece of PITCH_FIXTURES) fillTiles(tiles, piece, 'footing');
  // D-135: the pitch's own fence, a solid ring round the field and both goals
  // with its two gates closed in it. `railing` is solid, so the only way in or
  // out is a press of E at a gate — the arena ring's rule. The main stand and
  // the south bleachers are both outside it, so the benches stay reachable.
  for (let row = PITCH_PEN.y; row < PITCH_PEN.y + PITCH_PEN.height; row++) {
    for (let col = PITCH_PEN.x; col < PITCH_PEN.x + PITCH_PEN.width; col++) {
      if (isPitchFenceTile(col, row)) fillTiles(tiles, { x: col, y: row, width: 1, height: 1 }, 'railing');
    }
  }
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

/** Whether a street tile lies inside the pitch's fence: the field, both goals and the walkway round them. */
export function isInPitchPen(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && inPitchRect(PITCH_PEN_INTERIOR, x, y);
}

/** The pitch's two gates, as the World draws and prompts them (D-135). */
export const PITCH_PEN_GATES = PITCH_GATES;

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
