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
  | 'vault';

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

// ---------------------------------------------------------------------------
// Lobby presence
// ---------------------------------------------------------------------------

/**
 * Ephemeral, per-session player identity.
 *
 * Generated client-side, never derived from an address, discarded on
 * disconnect. This type must never be widened to carry anything identifying.
 */
export type GameId = string & { readonly __brand: 'GameId' };

export interface Position {
  x: number;
  y: number;
}

export type Facing = 'up' | 'down' | 'left' | 'right';

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

/** Emitted by the world, consumed by the shell. Semantic, never financial. */
export interface WorldEvents {
  'building:entered': { building: BuildingId };
  'building:exited': { building: BuildingId };
  'building:locked': { building: BuildingId; reason: 'coming-soon' };
  'player:moved': { position: Position; facing: Facing };
  'world:ready': Record<string, never>;
}

/**
 * Pushed by the shell into the world. Presentation data only.
 *
 * Deliberately pre-formatted: the world receives `"12.5 STRK"`, never a
 * bigint and never a token address. Phaser cannot be tempted into arithmetic
 * on money it should not hold.
 */
export interface ShellEvents {
  /** Pre-formatted for display. Null while unknown or disconnected. */
  'hud:balance': { display: string | null };
  /** Count of in-flight operations, for an ambient indicator. */
  'hud:pending': { count: number };
  /** Drives door states and prompt copy. */
  'wallet:status': { status: WalletStatus };
  /** Ask the world to release the player from a building interior. */
  'world:exit-building': Record<string, never>;
}

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
