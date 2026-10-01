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
  | 'plaza';

/** The five buildings with a street door. The Privacy Plaza has none (D-076). */
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
 * presence leak is accepted for v1 by D-019. D-087's two shared rooms (the
 * Exchange roof and the Avatar Studio) are presence areas the lobby keeps on
 * its side only: no field here says which area a player is in.
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

/** A player climbs at most this many blocks when stepping onto a neighbour. */
export const SANDBOX_STEP_HEIGHT = 1;

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
// Only the overworld and two approved rooms are multiplayer. Every other
// interior is a private solo instance: entering it suspends presence (D-019).
// A live player is in exactly one area, and sees and is seen by players in the
// same area. One view is one-way on top of that: a roof player also sees the
// street below, and no street player sees the roof. The area is the lobby's
// server-side bookkeeping, never a field of `PresenceState`, so no player's
// area is ever broadcast.

/**
 * Where a live player is. `street` is the overworld (the road, the sandbox,
 * the pitch and the plaza); `roof` is the Exchange tower's roof, reached by
 * lift; `studio` is the Avatar Studio. A suspended player is in none.
 */
export type PresenceArea = 'street' | 'roof' | 'studio';

/** Every presence area, street first. */
export const PRESENCE_AREAS: readonly PresenceArea[] = Object.freeze(['street', 'roof', 'studio'] as const);

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
 * D-087: the Avatar Studio, drawn at the interiors' origin (two tiles in from
 * the street's corner, over the hidden street): its floor inside the wall
 * ring, and the two-tile return portal in the top wall. Mirrors the World's
 * `AVATAR_STUDIO_DEFINITION`, and a World test fails if the two drift.
 */
export const STUDIO_PRESENCE_GRID: PresenceAreaGrid = Object.freeze({
  originX: 2 * 32,
  originY: 2 * 32,
  tileSize: 32,
  width: 18,
  height: 12,
  walkable: Object.freeze([
    Object.freeze({ x: 1, y: 1, width: 16, height: 10 }),
    Object.freeze({ x: 8, y: 0, width: 2, height: 1 }),
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
  'player:moved': { position: Position; facing: Facing };
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
   * D-087: where the player stands inside a shared area (the roof or the
   * Avatar Studio), in that area's World pixels. Emitted on arrival, before
   * the area's entered event, and on every frame the player moves there.
   * Never on the street (that is `player:moved`) and never in a private
   * interior, so a street consumer never reads a room's coordinates.
   */
  'area:moved': { position: Position; facing: Facing };
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
