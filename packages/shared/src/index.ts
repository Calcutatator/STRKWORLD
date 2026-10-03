/**
 * Shared vocabulary. Types and constants only — no logic, no dependencies.
 *
 * ⚠ FROZEN SEAM. Three lanes depend on this file simultaneously, so a change
 * here breaks all of them at once. Changes require a decision entry in
 * docs/DECISIONS.md — see docs/WORKPLAN.md.
 */

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildingId =
  /** STRK20 pool — shield, unshield, private transfer. */
  | 'bank'
  /** AVNU private swaps. */
  | 'exchange'
  /** Private address-to-address transfer. */
  | 'post-office'
  /** Deposit from any chain -> STRK -> pool, via NEAR Intents. Arrival is public. */
  | 'bridge'
  /**
   * Vesu lending from the player's STRK20 shadow account, open only when a
   * build switches it on (D-077); otherwise the locked facade of D-007.
   */
  | 'vault'
  /**
   * D-076: the Privacy Plaza, an open square south of the street's west end,
   * beside D-078's football pitch.
   * Not a building: no door, no room, no route and no money. It is an id only
   * so its two stations share the station vocabulary (`plaza:monument`,
   * `plaza:shells`), and `BUILDINGS` below leaves it out.
   */
  | 'plaza'
  /**
   * D-107: a hidden room under the street, down a service stair in the alley
   * across the road from the Privacy Plaza. A codename only: the game never
   * shows it, and the room has no facade, sign, name, route or money. It is
   * an id so its door and room reuse the fixed rooms' machinery. `BUILDINGS`
   * leaves it out, so the Shell opens no window for it, while its
   * `building:entered` suspends presence like any private interior's
   * (D-019, D-087).
   */
  | 'bunker'
  /** D-114: the gladiator pit's arena. A codename only: no route, panel or money; BUILDINGS leaves it out. */
  | 'arena';

/** The five buildings with a street door. The Privacy Plaza has none (D-076); the bunker's door is hidden (D-107). */
export const BUILDINGS: readonly BuildingId[] = [
  'bank',
  'exchange',
  'post-office',
  'bridge',
  'vault',
] as const;

/**
 * Functional in every build. The Vault opens only when a build switches it on
 * (D-077); otherwise it renders as D-007's facade with its door locked.
 */
export const ACTIVE_BUILDINGS: readonly BuildingId[] = [
  'bank',
  'exchange',
  'post-office',
  'bridge',
] as const;

/**
 * Whether a building's activity touches the STRK20 pool.
 *
 * The Bridge does not. It moves value between chains over public rails, and
 * the privacy step happens afterwards at the Bank. This distinction drives
 * user-facing copy — never imply the Bridge is private.
 */
export const SHIELDED_BUILDINGS: readonly BuildingId[] = [
  'bank',
  'exchange',
  'post-office',
  'vault',
] as const;

/**
 * Client-local identifier for a station inside a building room.
 *
 * The suffix is presentation vocabulary owned by the World/Shell integration,
 * never a route, selector, intent or financial payload. Shell validates the
 * full id against its station registry before opening a function window.
 */
export type StationId = `${BuildingId}:${string}`;

// ---------------------------------------------------------------------------
// Lobby presence
// ---------------------------------------------------------------------------

/**
 * Ephemeral, per-session player identity.
 *
 * Minted by the trusted lobby server, never derived from an address, discarded
 * on disconnect. This type must never be widened to carry anything identifying.
 */
export type GameId = string & { readonly __brand: 'GameId' };

export interface Position {
  x: number;
  y: number;
}

export type Facing = 'up' | 'down' | 'left' | 'right';

/**
 * D-047's opaque cosmetic state keys. The World owns pair semantics; the
 * lobby only allowlists and carries the string in the existing sprite field.
 */
export type AvatarSpriteKey =
  | 'avatar-1'
  | 'avatar-2'
  | 'avatar-3'
  | 'avatar-4'
  | 'avatar-5'
  | 'avatar-6'
  | 'avatar-7'
  | 'avatar-8'
  | 'avatar-9'
  | 'avatar-10'
  | 'avatar-11'
  | 'avatar-12'
  | 'avatar-13'
  | 'avatar-14'
  | 'avatar-15'
  | 'avatar-16';

/**
 * ⚠ THE LOBBY SCHEMA — the enforcement point for "the lobby never sees money".
 *
 * This is the complete set of fields the lobby may broadcast or store. A field
 * that is not here cannot leak, which is the whole design. Adding one requires
 * a decision entry.
 *
 * Explicitly excluded, permanently: account address, any balance, transaction
 * hash, token symbol, building occupancy, and any financial action. On entry
 * the client leaves or suspends lobby presence, so other players see the
 * avatar disappear but the lobby never receives a building event or ID. That
 * presence leak is accepted for v1 by D-019. D-087's shared rooms (the
 * Exchange roof and the Avatar Studio, and the hidden bunker since D-112) are
 * presence areas the lobby keeps on its side only: no field here says which
 * area a player is in.
 */
export interface PresenceState {
  gameId: GameId;
  position: Position;
  facing: Facing;
  /** Sprite key from the asset registry. Cosmetic, player-chosen. */
  sprite: string;
  /**
   * D-060: the sandbox block colour this player is carrying, or -1. An opaque
   * palette index — cosmetic, never financial.
   */
  carrying: number;
  /**
   * D-097: how many times this player has jumped, modulo 256. A cosmetic
   * counter: a peer plays a jump when it changes. No time, no target, nothing
   * financial; only the room writes it, at most once per its jump floor.
   */
  jumps: number;
  /**
   * D-127: the bench seat this player is sitting on — an index into
   * `STREET_SEATS` (seats.ts) — or -1 standing. One signed byte, and the whole
   * of what sitting costs the wire: the seat's own spot and the way a sitter
   * looks are in the shared table, so nothing about a position or a pose has to
   * be sent. Cosmetic, like `carrying` and `jumps`. Only the room writes it,
   * and only for a real seat whose spot is where the room already holds that
   * player, and only while nobody else holds it. The Bridge room's lounge
   * seats are in a solo interior and never reach here.
   */
  seat: number;
}

// ---------------------------------------------------------------------------
// The district's columns — D-078
// ---------------------------------------------------------------------------
//
// The road runs between two squares of the same size: the football pitch at
// its west end and the block sandbox at its east end. The pitch square came
// second, so the street it widened moved east behind one constant.

/** A street tile rectangle, in tiles. */
export interface TileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * D-078: street tile rectangle of the football pitch square, in tiles: as
 * big as the sandbox's, at the other end of the road.
 */
export const PITCH_AREA: TileRect = Object.freeze({ x: 0, y: 0, width: 28, height: 28 });

/**
 * D-078: the column where the protocol street begins. The pitch square's
 * fence stands one tile east of it, as the sandbox's wall stands one tile west
 * of the sandbox, and the street starts one tile past that fence. Everything
 * east of the square — buildings, doors, the spawn, the Studio path, the
 * Privacy Plaza and the sandbox — is laid out from this column, so it is the
 * one constant the district widened by.
 */
export const STREET_ORIGIN_X = PITCH_AREA.x + PITCH_AREA.width + 1;

// ---------------------------------------------------------------------------
// The block sandbox — D-060
// ---------------------------------------------------------------------------
//
// A shared play area at the east end of the road. Its only state is which
// street tiles hold stacks of coloured blocks: anonymous, cosmetic and
// unrelated to money. The lobby stores it so every player sees the same
// blocks; nothing here identifies a player or a financial action.

/** Street tile rectangle of the sandbox, in tiles. Laid out from `STREET_ORIGIN_X` (D-078). */
export const SANDBOX_AREA: Readonly<{ x: number; y: number; width: number; height: number }> =
  Object.freeze({ x: STREET_ORIGIN_X + 54, y: 0, width: 28, height: 28 });

/**
 * The way in: the tiles just inside the square's gate, where the road and
 * pavements enter from the west. Sky drops and returned blocks never land
 * here, and a stack here never grows past one step (`SANDBOX_STEP_HEIGHT`),
 * so neither the rain nor a player can wall the entrance off — players may
 * still lay blocks in it. A street tile rectangle inside `SANDBOX_AREA`,
 * flush with its west edge; the gate is the gap in the wall just west of it,
 * `height` tiles wide.
 */
export const SANDBOX_ENTRANCE: Readonly<{ x: number; y: number; width: number; height: number }> =
  Object.freeze({ x: SANDBOX_AREA.x, y: 11, width: 3, height: 8 });

/** Tallest stack a column may reach. The sky is effectively open. */
export const SANDBOX_MAX_HEIGHT = 256;

/**
 * D-071, threshold set by D-075: the most blocks a column may hold, 14: the
 * 15th block — the one that would make a column 15 tall — bursts the sandbox
 * instead of stacking, and every placed block flies away and the square is
 * empty again.
 */
export const SANDBOX_BURST_HEIGHT = 14;

/** Every block in the sandbox, carried blocks included. */
export const SANDBOX_MAX_BLOCKS = 900;

/** Block colours are opaque palette indices `0 .. SANDBOX_COLOURS - 1`. */
export const SANDBOX_COLOURS = 8;

/**
 * A player climbs at most this many blocks when stepping onto a neighbour,
 * and since D-106 only with a jump: walking into any higher surface is a
 * wall. Stepping down is free.
 */
export const SANDBOX_STEP_HEIGHT = 1;

/**
 * A block's height in World units (one unit is a street tile): blocks are
 * cubes one tile on a side. The 3D sandbox draws them at this size, and the
 * jump's apex is derived from it (D-097, amended), so a jump always clears
 * the block it climbs (`SANDBOX_STEP_HEIGHT` of these).
 */
export const SANDBOX_BLOCK_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Jump to climb — D-106
// ---------------------------------------------------------------------------
//
// A general movement rule for every raised walkable surface (today, only
// sandbox stacks: every other raised thing in the World is a solid fixture).
// Walking never steps up. A jump past `CLIMB_FROM_PHASE` of its air time and
// not yet landed may step up `SANDBOX_STEP_HEIGHT`, once per jump. The World
// predicts it from the jump's phase; the lobby accepts it within
// `CLIMB_WINDOW_MS` of receiving the jump.

/**
 * D-097, amended: how long every jump is in the air, ms: every avatar's, and
 * reduced motion's (which only lowers the hop). The World's arc runs on it;
 * the lobby's climb window and jump floor are derived from it, so the two
 * cannot drift apart.
 */
export const JUMP_AIR_MS = 800;

/**
 * D-106: latency the lobby tolerates between a jump and the move that climbs:
 * the 50 ms move floor plus 100 ms of jitter.
 */
export const CLIMB_LATENCY_MS = 150;

/**
 * From this fraction of a jump's air time until it lands, the jumper may step
 * onto a surface one block higher. Normalised, so a lower or shorter jump
 * clears the same block: the rule never reads the jump's height.
 */
export const CLIMB_FROM_PHASE = 0.35;

/**
 * The lobby accepts one step up for this long after it receives the jump: the
 * World's air time (`JUMP_AIR_MS`, 800 ms), plus `CLIMB_LATENCY_MS` (150 ms)
 * for the move floor and jitter between the jump and the move that climbs:
 * 950 ms.
 */
export const CLIMB_WINDOW_MS = JUMP_AIR_MS + CLIMB_LATENCY_MS;

// ---------------------------------------------------------------------------
// Jump over — D-130
// ---------------------------------------------------------------------------
//
// The same shape of rule for the things that stand on the ground rather than
// above it: between these two fractions of its air time, a jump's feet are
// above knee height, and the football is not a body the jumper meets. Phase
// based like the climb window, so reduced motion's lower hop clears the same
// ball: the rule never reads the jump's height.

/**
 * D-130: from this fraction of a jump's air time, the feet are clear of
 * anything standing on the ground. On the full arc 10% of the air is 0.47
 * units up — past the knee, well short of the waist.
 */
export const JUMP_PASS_FROM_PHASE = 0.1;

/** D-130: and until this fraction, the mirror of `JUMP_PASS_FROM_PHASE` on the fall. */
export const JUMP_PASS_UNTIL_PHASE = 0.9;

/**
 * D-130: the lobby treats a session as airborne for this long after it
 * receives the jump: to the end of the pass window (`JUMP_PASS_UNTIL_PHASE`
 * of `JUMP_AIR_MS`, 720 ms) plus `CLIMB_LATENCY_MS` for the move floor and
 * jitter, 870 ms. It opens as the jump arrives rather than at
 * `JUMP_PASS_FROM_PHASE`, because the jump reaches the room before the move
 * that carries the jumper over the ball and the extra 80 ms costs only a push
 * that was not going to happen.
 */
export const JUMP_PASS_WINDOW_MS = JUMP_AIR_MS * JUMP_PASS_UNTIL_PHASE + CLIMB_LATENCY_MS;

/**
 * The avatar's square collision body, in World pixels. The World collides
 * with it and stands it on the tallest stack it overlaps; the lobby measures
 * a step up with the same body (D-106), so both agree on when a climb began.
 */
export const PLAYER_BODY_SIZE = 24;

/**
 * Block tops a player can pick up or place onto, relative to the level they
 * stand on: from one below their feet to two above.
 */
export const SANDBOX_REACH_BELOW = 1;
export const SANDBOX_REACH_ABOVE = 2;

/** A sandbox tile, in street tile coordinates. */
export interface SandboxTile {
  x: number;
  y: number;
}

/** One stack of blocks: colour indices from the ground up. */
export interface SandboxColumn {
  x: number;
  y: number;
  colours: readonly number[];
}

/** Everything a client needs to draw the sandbox. */
export interface SandboxSnapshot {
  /** Only columns holding at least one block. */
  columns: readonly SandboxColumn[];
  /** The colour this client carries, or null. */
  carrying: number | null;
}

// ---------------------------------------------------------------------------
// The football pitch — D-078
// ---------------------------------------------------------------------------
//
// One shared ball on a pitch at the west end of the road. The lobby is its
// authority and simulates it on a fixed tick while anyone is near; its whole
// state is the ball, the score and the phase of play — anonymous, cosmetic and
// unrelated to money. No kick, goal or score names a player, and there are no
// per-player statistics anywhere.

/**
 * The field, in street tiles: the rectangle inside the touchlines and the goal
 * lines. The long axis runs east-west, so the north-facing camera sees it as a
 * broadcast does. The ball stays inside it, or inside a goal.
 */
export const PITCH_FIELD: TileRect = Object.freeze({ x: 3, y: 7, width: 22, height: 16 });

/**
 * Each goal, in tiles: `width` between the posts' centres, centred on the
 * field's middle, and `depth` of net behind the goal line. The posts stand
 * just behind the line, their faces on it (`FOOTBALL_POST_RADIUS`), so the
 * frame stands wholly on the goal's solid footing.
 */
export const PITCH_GOAL: Readonly<{ width: number; depth: number }> = Object.freeze({ width: 4, depth: 1 });

/** The ball's radius, in tiles. */
export const FOOTBALL_BALL_RADIUS = 0.25;

/** A goal post's radius, in tiles; its centre stands this far behind the goal line. */
export const FOOTBALL_POST_RADIUS = 0.1;

/** The furthest a player's centre may be from the ball's centre and kick it, in tiles. */
export const FOOTBALL_KICK_RANGE = 1.3;

/** The first side to this many goals wins, and the score starts again from 0–0. */
export const FOOTBALL_WIN_SCORE = 5;

/** One step of the ball's simulation, in ms: 25 steps a second. */
export const FOOTBALL_TICK_MS = 40;

/**
 * A team, named for the goal it defends: West defends the west goal, so a
 * ball into the east goal is West's.
 */
export type FootballSide = 'west' | 'east';

/**
 * `live`: in play. `goal`: a goal was just scored, the ball is dead and the
 * pitch celebrates. `full-time`: a side reached `FOOTBALL_WIN_SCORE`; then the
 * score goes back to 0–0 and play kicks off again.
 */
export type FootballPhase = 'live' | 'goal' | 'full-time';

/** The ball and the scoreboard, as the authority holds them. */
export interface FootballSnapshot {
  /** The simulation step this is, counted in `FOOTBALL_TICK_MS` from the authority's start. */
  readonly tick: number;
  /** The ball's centre, in World pixels. */
  readonly x: number;
  readonly y: number;
  /** The ball's velocity, in World pixels per second. */
  readonly vx: number;
  readonly vy: number;
  readonly west: number;
  readonly east: number;
  readonly phase: FootballPhase;
}

/** A goal, as broadcast: the side that scored, and nothing else. */
export interface FootballGoal {
  readonly side: FootballSide;
}

// ---------------------------------------------------------------------------
// Presence areas — D-087
// ---------------------------------------------------------------------------
//
// Only the overworld and an approved list of rooms are multiplayer: the
// Exchange roof and the Avatar Studio (D-087), and the hidden bunker (D-112).
// Every other interior is a private solo instance: entering it suspends
// presence (D-019). A live player is in exactly one area, and sees and is seen
// by players in the same area. One view is one-way on top of that: a roof
// player also sees the street below, and no street player sees the roof. The
// area is the lobby's server-side bookkeeping, never a field of
// `PresenceState`, so no player's area is ever broadcast.

/**
 * Where a live player is. `street` is the overworld (the road, the sandbox,
 * the pitch and the plaza); `roof` is the Exchange tower's roof, reached by
 * lift; `studio` is the Avatar Studio; `bunker` is the hidden room under the
 * alley (D-107, shared since D-112); `arena` is the gladiator pit's arena
 * (D-114). A suspended player is in none.
 */
export type PresenceArea = 'street' | 'roof' | 'studio' | 'bunker' | 'arena';

/** Every presence area, street first. */
export const PRESENCE_AREAS: readonly PresenceArea[] = Object.freeze(['street', 'roof', 'studio', 'bunker', 'arena'] as const);

/**
 * D-112: the presence area a building's whole interior is, or null for a
 * private one. The hidden bunker, and since D-114 the gladiator pit's arena:
 * each door is a building door, so the
 * World announces it with `building:entered` / `building:exited`, and the
 * Shell goes live in this area instead of suspending. (The roof is one floor
 * of the Exchange and has its own events; the Studio is not a building.)
 * Takes anything, so an untrusted payload can be asked directly.
 */
export function presenceAreaOfBuilding(building: unknown): PresenceArea | null {
  if (building === 'bunker') return 'bunker';
  if (building === 'arena') return 'arena';
  return null;
}

/**
 * A shared room's walkable grid, as the lobby checks a position against it.
 * Positions are World pixels, in the same space the World draws the room in.
 */
export interface PresenceAreaGrid {
  /** World pixel position of the grid's tile (0, 0). */
  readonly originX: number;
  readonly originY: number;
  /** World pixels per tile. */
  readonly tileSize: number;
  /** The whole grid, in its own tiles: for the roof, the tower's street footprint. */
  readonly width: number;
  readonly height: number;
  /** Walkable tile rectangles, in the grid's own tiles. Every other tile is solid. */
  readonly walkable: readonly TileRect[];
}

/**
 * D-087: the Exchange tower's roof deck. Its grid lies over the tower's street
 * footprint (street tiles `STREET_ORIGIN_X + 12` to `+ 18`, rows 5 to 10),
 * raised to the roof; the walkable deck is the 5 by 4 inside its ledge ring,
 * lift pad included. Mirrors the World's `EXCHANGE_ROOF_LEVEL`, and a World
 * test fails if the two drift.
 */
export const ROOF_PRESENCE_GRID: PresenceAreaGrid = Object.freeze({
  originX: (STREET_ORIGIN_X + 12) * 32,
  originY: 5 * 32,
  tileSize: 32,
  width: 7,
  height: 6,
  walkable: Object.freeze([Object.freeze({ x: 1, y: 1, width: 5, height: 4 })]),
});

/**
 * D-087, D-134: the Garden (the area id stays `studio`), drawn at the
 * interiors' origin (two tiles in from the street's corner, over the hidden
 * street).
 *
 * Thirty by twenty-four inside a hedge, with the two-tile gate in the top
 * wall. Walkable is the lane grid — five north-south lanes and five
 * east-west walks — plus each of the sixteen nooks' lawn: the lip in front
 * of the figure and the three tiles the figure stands on. A nook's back bed
 * and its two side beds are planted, so they are not walkable.
 *
 * Mirrors the World's `AVATAR_STUDIO_DEFINITION`, and a World test fails
 * tile by tile if the two drift.
 */
export const STUDIO_PRESENCE_GRID: PresenceAreaGrid = Object.freeze({
  originX: 2 * 32,
  originY: 2 * 32,
  tileSize: 32,
  width: 30,
  height: 24,
  walkable: Object.freeze([
    // The gate back to the street.
    Object.freeze({ x: 14, y: 0, width: 2, height: 1 }),
    // The five north-south lanes, gate to south walk.
    Object.freeze({ x: 1, y: 1, width: 2, height: 22 }),
    Object.freeze({ x: 8, y: 1, width: 1, height: 22 }),
    Object.freeze({ x: 14, y: 1, width: 2, height: 22 }),
    Object.freeze({ x: 21, y: 1, width: 1, height: 22 }),
    Object.freeze({ x: 27, y: 1, width: 2, height: 22 }),
    // The five east-west walks; each but the first carries the lip of the
    // nook row north of it.
    Object.freeze({ x: 1, y: 1, width: 28, height: 2 }),
    Object.freeze({ x: 1, y: 5, width: 28, height: 3 }),
    Object.freeze({ x: 1, y: 10, width: 28, height: 3 }),
    Object.freeze({ x: 1, y: 15, width: 28, height: 3 }),
    Object.freeze({ x: 1, y: 20, width: 28, height: 3 }),
    // The sixteen nooks' lawn, where the figure stands between its beds.
    Object.freeze({ x: 4, y: 4, width: 3, height: 1 }),
    Object.freeze({ x: 10, y: 4, width: 3, height: 1 }),
    Object.freeze({ x: 17, y: 4, width: 3, height: 1 }),
    Object.freeze({ x: 23, y: 4, width: 3, height: 1 }),
    Object.freeze({ x: 4, y: 9, width: 3, height: 1 }),
    Object.freeze({ x: 10, y: 9, width: 3, height: 1 }),
    Object.freeze({ x: 17, y: 9, width: 3, height: 1 }),
    Object.freeze({ x: 23, y: 9, width: 3, height: 1 }),
    Object.freeze({ x: 4, y: 14, width: 3, height: 1 }),
    Object.freeze({ x: 10, y: 14, width: 3, height: 1 }),
    Object.freeze({ x: 17, y: 14, width: 3, height: 1 }),
    Object.freeze({ x: 23, y: 14, width: 3, height: 1 }),
    Object.freeze({ x: 4, y: 19, width: 3, height: 1 }),
    Object.freeze({ x: 10, y: 19, width: 3, height: 1 }),
    Object.freeze({ x: 17, y: 19, width: 3, height: 1 }),
    Object.freeze({ x: 23, y: 19, width: 3, height: 1 }),
  ]),
});

/**
 * D-112: the hidden bunker (D-107), drawn at the interiors' origin like every
 * fixed room: the 16 by 10 net cafe's floor between its booths, shelves and
 * counters, and the two-tile stair back up in the bottom wall. The lift's
 * doors (`bunker:elevator`, out of order) and every fixture are solid.
 * Mirrors the World's `BUNKER_ROOM_DEFINITION`, and a World test fails if
 * the two drift.
 */
export const BUNKER_PRESENCE_GRID: PresenceAreaGrid = Object.freeze({
  originX: 2 * 32,
  originY: 2 * 32,
  tileSize: 32,
  width: 16,
  height: 10,
  walkable: Object.freeze([
    // The spine north from the landing, past the lift's shaft.
    Object.freeze({ x: 3, y: 1, width: 1, height: 8 }),
    // The landing at the stair's foot, the lift's approach and the stair.
    Object.freeze({ x: 1, y: 7, width: 2, height: 3 }),
    // The north corridor, into the booth area.
    Object.freeze({ x: 4, y: 2, width: 11, height: 1 }),
    // The booth area, between its booths and the toppled chairs.
    Object.freeze({ x: 9, y: 3, width: 5, height: 1 }),
    Object.freeze({ x: 9, y: 4, width: 2, height: 1 }),
    Object.freeze({ x: 12, y: 4, width: 2, height: 1 }),
    // The south corridor.
    Object.freeze({ x: 4, y: 5, width: 10, height: 1 }),
    Object.freeze({ x: 9, y: 6, width: 3, height: 1 }),
    Object.freeze({ x: 13, y: 6, width: 1, height: 1 }),
    // The gap between the fridge and the manga shelves, and the lobby.
    Object.freeze({ x: 9, y: 7, width: 1, height: 1 }),
    Object.freeze({ x: 4, y: 8, width: 11, height: 1 }),
  ]),
});

// ---------------------------------------------------------------------------
// The event bus — world ↔ shell
// ---------------------------------------------------------------------------
//
// One-directional by design. The shell owns wallet and financial state and
// pushes presentation data into the world; the world emits semantic events and
// never reads shell state or calls Starknet.
//
// Named "event bus" rather than "bridge" to avoid collision with the Bridge
// building.

/**
 * Emitted by the world, consumed by the shell. Semantic, never financial.
 *
 * Declared as a `type`, not an `interface`, and it matters: TypeScript gives
 * type aliases an implicit index signature but not interfaces, so an interface
 * here cannot satisfy `EventBus`'s `Record<string, unknown>` constraint. Nine
 * typecheck errors came from exactly that. Do not convert it back.
 */
export type WorldEvents = {
  'building:entered': { building: BuildingId };
  'building:exited': { building: BuildingId };
  'building:locked': { building: BuildingId; reason: 'coming-soon' };
  /** Client-local presentation event. Financial meaning stays in the Shell. */
  'station:activated': { building: BuildingId; station: StationId };
  /**
   * Where the player stands on the street, and which way they face. D-127's
   * `seat` is present only while they sit on a bench — an index into
   * `STREET_SEATS` — so a standing player's payload is unchanged. The Shell
   * passes it straight to the lobby with the position; the room decides
   * whether the claim stands.
   *
   * D-130: `airborne` is present, and true, only while the jumper's feet are
   * clear of the ground, so a walking player's payload is unchanged too. It is
   * for the ball the Shell draws, and is never sent to the lobby: the room
   * times its own jumps (`JUMP_PASS_WINDOW_MS`) rather than believe a client
   * that says it is in the air.
   */
  'player:moved': { position: Position; facing: Facing; seat?: number; airborne?: boolean };
  'world:ready': Record<string, never>;
  /** D-047: non-financial hidden Avatar Studio lifecycle. */
  'avatar-studio:entered': Record<string, never>;
  'avatar-studio:exited': Record<string, never>;
  /** D-047: selected state, still only cosmetic presentation data. */
  'avatar:selected': { sprite: AvatarSpriteKey };
  /**
   * D-087: the Exchange lift reached its roof, a shared presence area, or the
   * player left it (by lift, or released from the building). Emitted inside
   * the building's visit: `building:entered` came first, and when the visit
   * ends from the roof `rooftop:exited` comes before `building:exited`.
   */
  'rooftop:entered': Record<string, never>;
  'rooftop:exited': Record<string, never>;
  /**
   * D-087: where the player stands inside a shared area (the roof, the
   * Avatar Studio or, since D-112, the bunker), in that area's World pixels.
   * Emitted on arrival, before the area's entered event (for the bunker,
   * its `building:entered`), and on every frame the player moves there.
   * Never on the street (that is `player:moved`) and never in a private
   * interior, so a street consumer never reads a room's coordinates.
   */
  'area:moved': { position: Position; facing: Facing };
  /**
   * D-097: the local avatar jumped (Space). Cosmetic: the jump never changes
   * movement or collision. The Shell forwards it to the lobby only while the
   * player is live in a shared presence area; never from a private interior.
   */
  'player:jumped': Record<string, never>;
  /**
   * D-076: the player came within sight of the Privacy Plaza, or left it.
   * Presentation only: while it is near, the Shell reads the pool's public
   * aggregate stats for the monument. Never forwarded to the lobby.
   */
  'plaza:nearby': { near: boolean };
};

/**
 * Pushed by the shell into the world. Presentation data only.
 *
 * Deliberately pre-formatted: the world receives `"12.5 STRK"`, never a
 * bigint and never a token address. Phaser cannot be tempted into arithmetic
 * on money it should not hold.
 */
export type ShellEvents = {
  /** Pre-formatted for display. Null while unknown or disconnected. */
  'hud:balance': { display: string | null };
  /** Count of in-flight operations, for an ambient indicator. */
  'hud:pending': { count: number };
  /** Drives door states and prompt copy. */
  'wallet:status': { status: WalletStatus };
  /** Transfer keyboard/movement ownership without exposing Shell mode state. */
  'world:control-owner': {
    building: BuildingId;
    owner: 'world' | 'shell';
  };
  /** Presentation-only station labels and lock state. Missing means locked. */
  'world:stations': {
    building: BuildingId;
    stations: readonly {
      station: StationId;
      label: string;
      status: 'available' | 'locked';
    }[];
  };
  /** Ask the world to release the player from the named building interior. */
  'world:exit-building': { building: BuildingId };
  /**
   * D-076: the Privacy Plaza monument's figures, pre-formatted like
   * `hud:balance` ("2,932", "$1.18M"). Public pool-wide aggregates only,
   * never anything about this player. Null while unknown (loading, or a read
   * that failed), which the monument draws as "…".
   *
   * D-080: `held`'s per-pinned-token amounts were replaced with the pool's
   * USD value and its top holdings by value, read from Voyager through
   * strkprice.com (a public aggregate, no key, no user data).
   *
   * D-098: the 24-hour deposit count is gone from the event; `valueUsd` is
   * the monument's total, shown once on its own face.
   */
  'plaza:stats': {
    accounts: string | null;
    /** Compact total held in the pool, e.g. "$1.18M". */
    valueUsd: string | null;
    /** Compact "SYMBOL · $usd" lines, most valuable first, for the cycling face. */
    topHoldings: readonly string[] | null;
  };
};

/**
 * Connection state as the world needs to understand it.
 *
 * `unsupported` is a distinct state, not an error: the player has a wallet
 * that cannot do STRK20, and the door copy should say so plainly rather than
 * failing at the point of action.
 */
export type WalletStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unsupported'
  | 'unregistered';

export type EventName = keyof WorldEvents | keyof ShellEvents;

// ---------------------------------------------------------------------------
// Event bus contract
// ---------------------------------------------------------------------------

/**
 * A typed publish/subscribe channel.
 *
 * Type-only, because `packages/shared` holds no logic. The shell constructs the
 * implementation and hands it to the world at init, which is what keeps the
 * dependency pointing one way: the world receives a bus, it never reaches for
 * one.
 */
export interface EventBus<Events extends Record<string, unknown>> {
  emit<K extends keyof Events>(event: K, payload: Events[K]): void;
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;
  once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;
  off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): void;
  /** Drop every listener. Call on teardown so HMR does not accumulate them. */
  clear(): void;
}

/** What the world receives: it emits WorldEvents and listens for ShellEvents. */
export type WorldBus = EventBus<WorldEvents> & EventBus<ShellEvents>;

// D-114: the gladiator pit's arena: geometry, the ring as the wire carries it, combat constants.
export * from './arena.js';
// D-127: the overworld's sittable benches, and the seat table the wire indexes into.
export * from './seats.js';
// D-133: the Exchange roof's lookout swing: its tiles, the swing as the wire
// carries it, and the ride's timings. Last, because it reads
// `ROOF_PRESENCE_GRID` above (inside its functions only).
export * from './roof-swing.js';
