/**
 * D-135: the gated 2v2 football pitch. The fence and its two gates as
 * geometry the World draws and the lobby enforces, the match as the wire
 * carries it, and the match's constants.
 *
 * Nothing financial, and nothing here names a player except by the ephemeral
 * presence id every street peer within interest already holds — the same rule
 * the arena ring follows (`arena.ts`).
 *
 * The pitch stays in the `street` presence area: the stands are part of the
 * street and spectators watch from them. What makes it an instance is the
 * fence — a solid ring of railing with two closed gates — and the match
 * authority behind it, not a presence area of its own.
 */
import type { Facing, FootballSide, GameId, Position, TileRect } from './index.js';

/** World pixels to a street tile, as the rest of the pitch measures. */
export const PITCH_TILE_SIZE = 32;

/**
 * Mirrors `PITCH_FIELD` (D-078), deliberately as a value of its own rather
 * than an import: `index.ts` re-exports this file, so a value read back out of
 * it at module scope would be a cycle — the same reason `seats.ts` mirrors
 * `STREET_ORIGIN_X`. `pitch.test.ts` pins the two together, so the field
 * cannot move without this failing.
 */
const FIELD: TileRect = Object.freeze({ x: 3, y: 7, width: 22, height: 16 });

/** Mirrors `PITCH_GOAL` for the same reason, and pinned by the same test. */
const GOAL = Object.freeze({ width: 4, depth: 1 });

// ---------------------------------------------------------------------------
// The pen: the fence, its two gates and the places either side of them
// ---------------------------------------------------------------------------

/**
 * The fenced enclosure, in street tiles: the whole rectangle, whose *border*
 * is the fence and whose inside is the pen. The border runs just outside both
 * goals (the field plus a tile of walkway either end) and along row 6 to the
 * north and row 24 to the south, so the main stand (rows 0–4) and the south
 * bleachers (rows 25–26) both stay outside it — the benches on the bleachers
 * are still sittable from the street side (D-127).
 */
export const PITCH_PEN: TileRect = Object.freeze({ x: 1, y: 6, width: 26, height: 19 });

/** Inside the fence: the field, both goals and the walkway round them. */
export const PITCH_PEN_INTERIOR: TileRect = Object.freeze({
  x: PITCH_PEN.x + 1,
  y: PITCH_PEN.y + 1,
  width: PITCH_PEN.width - 2,
  height: PITCH_PEN.height - 2,
});

/**
 * The two gates, in the fence's north and south runs, centred on the halfway
 * line and two tiles wide. Both are solid like the rest of the fence: a gate
 * is a station, not a gap, so the only way in or out is a press of E (D-117),
 * exactly as the arena ring's gate works.
 */
export const PITCH_GATE_NORTH: TileRect = Object.freeze({ x: 13, y: PITCH_PEN.y, width: 2, height: 1 });
export const PITCH_GATE_SOUTH: TileRect = Object.freeze({
  x: 13,
  y: PITCH_PEN.y + PITCH_PEN.height - 1,
  width: 2,
  height: 1,
});

/** Which gate a press came from. Both behave the same; the pair exists so each has its own places. */
export type PitchGateSide = 'north' | 'south';

/** Wire code = index. Only the client's own prompt uses it; no state carries it. */
export const PITCH_GATE_SIDES: readonly PitchGateSide[] = Object.freeze(['north', 'south']);

/**
 * One gate: its tiles, the walkway tiles outside it a press is accepted from,
 * where a player is stood when they go in, and where they are put back when
 * they come out.
 *
 * The north gate's approach is the walkway in front of the main stand; the
 * south gate's is the aisle between the two bleachers. Both are reachable
 * from the square's own street gate without crossing the fence.
 */
export interface PitchGate {
  readonly side: PitchGateSide;
  readonly tiles: TileRect;
  /** Outside the fence: where E is pressed from, and where a leaver is put back. */
  readonly approach: TileRect;
  /** Inside the fence: where an entrant is stood, and the way they face. */
  readonly spawn: Position;
  readonly spawnFacing: Facing;
  /** Outside the fence: where a leaver is stood, and the way they face. */
  readonly exit: Position;
  readonly exitFacing: Facing;
}

const tile = (x: number, y: number): Position => Object.freeze({ x, y });

export const PITCH_GATES: readonly PitchGate[] = Object.freeze([
  Object.freeze({
    side: 'north' as const,
    tiles: PITCH_GATE_NORTH,
    approach: Object.freeze({ x: PITCH_GATE_NORTH.x, y: PITCH_GATE_NORTH.y - 1, width: 2, height: 1 }),
    spawn: tile(13, PITCH_GATE_NORTH.y + 1),
    spawnFacing: 'down' as const,
    exit: tile(13, PITCH_GATE_NORTH.y - 1),
    exitFacing: 'up' as const,
  }),
  Object.freeze({
    side: 'south' as const,
    tiles: PITCH_GATE_SOUTH,
    approach: Object.freeze({ x: PITCH_GATE_SOUTH.x, y: PITCH_GATE_SOUTH.y + 1, width: 2, height: 1 }),
    spawn: tile(14, PITCH_GATE_SOUTH.y - 1),
    spawnFacing: 'up' as const,
    exit: tile(14, PITCH_GATE_SOUTH.y + 1),
    exitFacing: 'down' as const,
  }),
]);

/** Whether a street tile is one of the fence's — the border of `PITCH_PEN`, gates included. */
export function isPitchFenceTile(x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (!inTileRect(PITCH_PEN, x, y)) return false;
  return !inTileRect(PITCH_PEN_INTERIOR, x, y);
}

/** Whether a street tile is one of a gate's. */
export function isPitchGateTile(x: number, y: number): boolean {
  return PITCH_GATES.some((gate) => inTileRect(gate.tiles, x, y));
}

/** Whether a street tile is inside the fence. */
export function isPitchPenTile(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && inTileRect(PITCH_PEN_INTERIOR, x, y);
}

/**
 * How far outside a gate's approach — or inside the fence, for a press that
 * leaves — a press of E is still accepted, in World pixels: a quarter tile,
 * the same slack the arena's gate allows.
 */
export const PITCH_APPROACH_SLACK_PX = 8;

/** Whether a World pixel position is inside the fence. The lobby's keep-out rule. */
export function isInsidePitchPen(x: number, y: number): boolean {
  return inPixelRect(PITCH_PEN_INTERIOR, x, y, 0);
}

/**
 * The gate a World pixel position may press, or null: the one whose approach
 * it stands on (from outside), or — once inside the fence — the one whose
 * spawn tile it stands on, which is how a participant walks back out.
 */
export function pitchGateAt(x: number, y: number): PitchGate | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const gate of PITCH_GATES) {
    if (inPixelRect(gate.approach, x, y, PITCH_APPROACH_SLACK_PX)) return gate;
    if (inPixelRect(gateSpawnTile(gate), x, y, PITCH_APPROACH_SLACK_PX)) return gate;
  }
  return null;
}

/** A gate's spawn tile as a one-tile rectangle. */
function gateSpawnTile(gate: PitchGate): TileRect {
  return { x: gate.spawn.x, y: gate.spawn.y, width: 1, height: 1 };
}

/** The World pixel centre of a street tile. */
export function pitchTileCentre(at: Position): Position {
  return Object.freeze({ x: (at.x + 0.5) * PITCH_TILE_SIZE, y: (at.y + 0.5) * PITCH_TILE_SIZE });
}

function inTileRect(rect: TileRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function inPixelRect(rect: TileRect, x: number, y: number, slack: number): boolean {
  return (
    x >= rect.x * PITCH_TILE_SIZE - slack &&
    x <= (rect.x + rect.width) * PITCH_TILE_SIZE + slack &&
    y >= rect.y * PITCH_TILE_SIZE - slack &&
    y <= (rect.y + rect.height) * PITCH_TILE_SIZE + slack
  );
}

// ---------------------------------------------------------------------------
// The four places: two per team, one in each half of their own side
// ---------------------------------------------------------------------------

/** How many take part in a match: 2v2. */
export const PITCH_SLOTS = 4;

/**
 * Where each slot's player is stood at a kick-off, and the zone its dummy
 * keeps to. Slots alternate teams so that two arrivals make one each: slot 0
 * is the Starks' north quarter, slot 1 the Snarks' north, slot 2 the Starks'
 * south and slot 3 the Snarks' south.
 */
export interface PitchQuarter {
  readonly side: FootballSide;
  readonly half: 'north' | 'south';
  /** The kick-off tile, and the way the player faces: toward the goal they attack. */
  readonly spot: Position;
  readonly facing: Facing;
  /** The quarter itself, in tiles: a dummy's home. */
  readonly quarter: TileRect;
  /** How far a dummy may stray from its quarter, in tiles. */
  readonly zone: TileRect;
}

/** How far outside its quarter a dummy may chase the ball, in tiles. */
export const PITCH_DUMMY_ZONE_SLACK = 4;

const FIELD_X1 = FIELD.x + FIELD.width;
const FIELD_Y1 = FIELD.y + FIELD.height;
const HALF_X = FIELD.x + FIELD.width / 2;
const HALF_Y = FIELD.y + FIELD.height / 2;

function quarterRect(side: FootballSide, half: 'north' | 'south'): TileRect {
  const x = side === 'starks' ? FIELD.x : HALF_X;
  const y = half === 'north' ? FIELD.y : HALF_Y;
  return Object.freeze({ x, y, width: FIELD.width / 2, height: FIELD.height / 2 });
}

function grown(rect: TileRect): TileRect {
  const s = PITCH_DUMMY_ZONE_SLACK;
  const x = Math.max(FIELD.x, rect.x - s);
  const y = Math.max(FIELD.y, rect.y - s);
  return Object.freeze({
    x,
    y,
    width: Math.min(FIELD_X1, rect.x + rect.width + s) - x,
    height: Math.min(FIELD_Y1, rect.y + rect.height + s) - y,
  });
}

function quarter(side: FootballSide, half: 'north' | 'south', spot: Position): PitchQuarter {
  const rect = quarterRect(side, half);
  return Object.freeze({
    side,
    half,
    spot,
    facing: side === 'starks' ? ('right' as const) : ('left' as const),
    quarter: rect,
    zone: grown(rect),
  });
}

export const PITCH_QUARTERS: readonly PitchQuarter[] = Object.freeze([
  quarter('starks', 'north', tile(8, 11)),
  quarter('snarks', 'north', tile(20, 11)),
  quarter('starks', 'south', tile(8, 19)),
  quarter('snarks', 'south', tile(20, 19)),
]);

/** The team a slot index plays for: even slots are the Starks', odd the Snarks'. */
export function pitchSlotSide(index: number): FootballSide {
  return index % 2 === 0 ? 'starks' : 'snarks';
}

/** Where someone is stood, and the way they face. */
export interface PitchStand {
  readonly spot: Position;
  readonly facing: Facing;
}

/**
 * Where each slot's player is put back when a match closes: one tile each,
 * just outside a gate, so four people leaving at once never land on the same
 * tile. Slots 0 and 1 come out of the north gate and 2 and 3 out of the
 * south, which is the half each was playing in.
 */
export const PITCH_SLOT_EXITS: readonly PitchStand[] = Object.freeze([
  Object.freeze({ spot: tile(13, PITCH_GATE_NORTH.y - 1), facing: 'up' as const }),
  Object.freeze({ spot: tile(14, PITCH_GATE_NORTH.y - 1), facing: 'up' as const }),
  Object.freeze({ spot: tile(13, PITCH_GATE_SOUTH.y + 1), facing: 'down' as const }),
  Object.freeze({ spot: tile(14, PITCH_GATE_SOUTH.y + 1), facing: 'down' as const }),
]);

// ---------------------------------------------------------------------------
// The match, as the wire carries it
// ---------------------------------------------------------------------------

/**
 * `open`: fewer than `PITCH_SLOTS` taking part; whoever is inside may walk
 * about and kick. `countdown`: the places are set and play has not started —
 * the 3–2–1 before a kick-off, and the shorter beat after a goal. `playing`:
 * in play. `ended`: a side reached `FOOTBALL_WIN_SCORE` and the winner's
 * banner is up, before everyone is put back outside and the pitch reopens.
 */
export type PitchMatchPhase = 'open' | 'countdown' | 'playing' | 'ended';

/** Wire code = index. */
export const PITCH_MATCH_PHASES: readonly PitchMatchPhase[] = Object.freeze([
  'open',
  'countdown',
  'playing',
  'ended',
]);

export type PitchSlotKind = 'empty' | 'player' | 'dummy';

/** Wire code = index. */
export const PITCH_SLOT_KINDS: readonly PitchSlotKind[] = Object.freeze(['empty', 'player', 'dummy']);

export interface PitchSlot {
  readonly kind: PitchSlotKind;
  /** The player's ephemeral presence id when kind is `player`; null otherwise. */
  readonly gameId: GameId | null;
  /**
   * A dummy's centre, in whole World pixels; (0, 0) for any other kind. A
   * player's place is their own presence entry, which peers already hold.
   */
  readonly x: number;
  readonly y: number;
}

export interface PitchMatchSnapshot {
  readonly phase: PitchMatchPhase;
  /** Mod 65536, +1 per match started: a new value is a new match. */
  readonly round: number;
  /** Always `PITCH_SLOTS` long, in `PITCH_QUARTERS` order. */
  readonly slots: readonly PitchSlot[];
  readonly starks: number;
  readonly snarks: number;
  /** Whole seconds left of a countdown; 0 in any other phase. */
  readonly secondsLeft: number;
  /** Non-null exactly when the phase is `ended`. */
  readonly winner: FootballSide | null;
}

/** The 3–2–1 before a kick-off, in ms. */
export const PITCH_COUNTDOWN_MS = 3_000;

/**
 * The shorter beat after a goal, in ms: the celebration is the wait. Equal to
 * the ball's own goal moment (`FOOTBALL_GOAL_MS`), so the countdown reaches
 * zero exactly as the ball becomes kickable again rather than before it.
 * `pitch-rules.test.ts` pins the two together.
 */
export const PITCH_RESTART_MS = 2_500;

/**
 * How long the winner's banner is up before everyone is put back outside, in
 * ms. Equal to the ball's own full-time moment (`FOOTBALL_FULL_TIME_MS`), so
 * the pitch reopens as the score goes back to 0–0.
 */
export const PITCH_RESULT_MS = 4_500;

/** The fastest a dummy moves, in World pixels per second: well under a player's sprint. */
export const PITCH_DUMMY_SPEED = 2.6 * PITCH_TILE_SIZE;

/** The most whole seconds `secondsLeft` may say. */
const PITCH_COUNTDOWN_SECONDS = Math.ceil(PITCH_COUNTDOWN_MS / 1000);

/** The longest presence id a slot may carry; the lobby mints 16 hex characters. */
const PITCH_GAME_ID_MAX_LENGTH = 64;

/** A dummy's centre is somewhere on the pitch square, in whole World pixels. */
const PITCH_MAX_PX = 28 * PITCH_TILE_SIZE;

/**
 * The mirrored field and goal, exported so `pitch.test.ts` can pin them
 * against `PITCH_FIELD` and `PITCH_GOAL` without this module importing them.
 */
export const PITCH_FIELD_MIRROR: TileRect = FIELD;
export const PITCH_GOAL_MIRROR: Readonly<{ width: number; depth: number }> = GOAL;

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function normalizePitchSlot(value: unknown): PitchSlot | null {
  const kind = ownData(value, 'kind');
  const gameId = ownData(value, 'gameId');
  const x = ownData(value, 'x');
  const y = ownData(value, 'y');
  if (typeof kind !== 'string' || !PITCH_SLOT_KINDS.includes(kind as PitchSlotKind)) return null;
  if (kind === 'player') {
    if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > PITCH_GAME_ID_MAX_LENGTH) return null;
  } else if (gameId !== null) {
    return null;
  }
  if (!isIntegerIn(x, 0, PITCH_MAX_PX) || !isIntegerIn(y, 0, PITCH_MAX_PX)) return null;
  // Only a dummy has a place of its own; anything else stands nowhere.
  if (kind !== 'dummy' && (x !== 0 || y !== 0)) return null;
  return Object.freeze({ kind: kind as PitchSlotKind, gameId: gameId as GameId | null, x, y });
}

/**
 * Validate an untrusted match snapshot, reading own data fields only (a
 * getter or an inherited field is never read). Codes in the tables, integers
 * in range, exactly `PITCH_SLOTS` slots, a winner exactly when the phase is
 * `ended`, and `secondsLeft` 0 outside a countdown. Anything else is null;
 * the result is frozen, slots included. The same discipline as
 * `normalizeArenaRing` and `normalizeFootballFrame`.
 */
export function normalizePitchMatch(value: unknown, winScore: number): PitchMatchSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const phase = ownData(value, 'phase');
  const round = ownData(value, 'round');
  const starks = ownData(value, 'starks');
  const snarks = ownData(value, 'snarks');
  const secondsLeft = ownData(value, 'secondsLeft');
  const rawWinner = ownData(value, 'winner');
  const rawSlots = ownData(value, 'slots');
  if (typeof phase !== 'string' || !PITCH_MATCH_PHASES.includes(phase as PitchMatchPhase)) return null;
  if (!isIntegerIn(round, 0, 0xffff)) return null;
  if (!isIntegerIn(starks, 0, winScore) || !isIntegerIn(snarks, 0, winScore)) return null;
  if (!isIntegerIn(secondsLeft, 0, phase === 'countdown' ? PITCH_COUNTDOWN_SECONDS : 0)) return null;
  if (!Array.isArray(rawSlots) || rawSlots.length !== PITCH_SLOTS) return null;
  const slots: PitchSlot[] = [];
  for (const raw of rawSlots) {
    const slot = normalizePitchSlot(raw);
    if (slot === null) return null;
    slots.push(slot);
  }
  let winner: FootballSide | null = null;
  if (phase === 'ended') {
    if (rawWinner !== 'starks' && rawWinner !== 'snarks') return null;
    winner = rawWinner;
  } else if (rawWinner !== null) {
    return null;
  }
  return Object.freeze({
    phase: phase as PitchMatchPhase,
    round,
    slots: Object.freeze(slots),
    starks,
    snarks,
    secondsLeft,
    winner,
  });
}
