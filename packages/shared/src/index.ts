/**
 * Shared vocabulary. Types and constants only — no logic, no dependencies.
 */

/** The buildings. A visible facade exists for each; `vault` is disabled in v1. */
export type BuildingId = 'bank' | 'exchange' | 'post-office' | 'vault';

export const BUILDINGS: readonly BuildingId[] = [
  'bank',
  'exchange',
  'post-office',
  'vault',
] as const;

/** Enabled in v1. The Vault ships as a facade only — see DECISIONS.md D-007. */
export const ACTIVE_BUILDINGS: readonly BuildingId[] = [
  'bank',
  'exchange',
  'post-office',
] as const;

/**
 * Ephemeral, per-session player identity for the lobby.
 *
 * Generated client-side, never derived from an address, discarded on
 * disconnect. This type must never be widened to carry anything identifying.
 */
export type GameId = string & { readonly __brand: 'GameId' };

/** A position in world space. */
export interface Position {
  x: number;
  y: number;
}

/** What the lobby broadcasts. Everything the lobby is allowed to know. */
export interface PresenceState {
  gameId: GameId;
  position: Position;
  sprite: string;
  facing: 'up' | 'down' | 'left' | 'right';
}

/** Events the world emits to the shell. Semantic, never financial. */
export interface WorldEvents {
  'building:entered': { building: BuildingId };
  'building:exited': { building: BuildingId };
  'player:moved': { position: Position };
}

/** Events the shell pushes into the world. Presentation data, never state. */
export interface ShellEvents {
  'hud:balance': { symbol: string; display: string };
  'hud:pending': { count: number };
  'wallet:connected': { connected: boolean };
}
