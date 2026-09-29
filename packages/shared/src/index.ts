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
  /** Vesu lending. Facade only in v1 — see DECISIONS.md D-007. */
  | 'vault'
  /**
   * D-076: the Privacy Plaza, an open square south of the road's west end.
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

/** Functional in v1. The Vault renders as a facade with its door locked. */
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
 * presence leak is accepted for v1 by D-019.
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
// The block sandbox — D-060
// ---------------------------------------------------------------------------
//
// A shared play area at the east end of the road. Its only state is which
// street tiles hold stacks of coloured blocks: anonymous, cosmetic and
// unrelated to money. The lobby stores it so every player sees the same
// blocks; nothing here identifies a player or a financial action.

/** Street tile rectangle of the sandbox, in tiles. */
export const SANDBOX_AREA: Readonly<{ x: number; y: number; width: number; height: number }> =
  Object.freeze({ x: 54, y: 0, width: 28, height: 28 });

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
  Object.freeze({ x: 54, y: 11, width: 3, height: 8 });

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
   * `hud:balance` ("2,932", "2.56M STRK"). Public pool-wide aggregates only,
   * never anything about this player. Null while unknown (loading, or a read
   * that failed), which the monument draws as "…".
   */
  'plaza:stats': {
    accounts: string | null;
    deposits24h: string | null;
    /** One line per token, in the Shell's order. */
    held: readonly string[] | null;
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
