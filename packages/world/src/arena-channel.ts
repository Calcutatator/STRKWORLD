import type { ArenaPhase, ArenaRingSnapshot, Facing, GameId } from '@strkworld/shared';

/**
 * D-114: the gladiator pit's arena, as the World sees it.
 *
 * The shared contract between the world scene (stream A), the lobby (B) and
 * the combat client (C). The Shell supplies the channel, as it does the
 * football's, so the World never imports the lobby. A wires the session into
 * `world-session.ts` through `ArenaSessionHost`; C fills `arena-session.ts`
 * and `three/arena-fx.ts` behind these interfaces without touching A's files.
 * Nothing here carries money, a name or an address.
 */

/** The World's view of the ring. The Shell supplies it: the lobby when live, the same rules locally when solo. */
export interface ArenaChannel {
  ring(): ArenaRingSnapshot | null;
  subscribe(listener: (ring: ArenaRingSnapshot | null) => void): () => void;
  /** This client's presence id (or the solo stand-in), null while unknown. */
  selfId(): GameId | null;
  claim(): void;
  attack(): void;
  leave(): void;
}

/** What world-session (A) gives the arena session (C). */
export interface ArenaSessionHost {
  /** Arena-local World pixels and facing of the local player. */
  position(): { readonly x: number; readonly y: number; readonly facing: Facing };
  /** Snap the local player to a tile with the jump choreography (a cut under reduced motion). */
  leapTo(tile: { readonly x: number; readonly y: number }, facing: Facing): void;
  setPrompt(text: string | null): void;
  playLocalSwing(): void;
  setOutfitLocked(locked: boolean): void;
  selectLook(mode: 'fighting' | 'restore'): void;
  reducedMotion(): boolean;
}

export interface ArenaViewFrame {
  readonly phase: ArenaPhase;
  readonly gate: 'open' | 'busy';
  readonly dummy: { readonly hp: number; readonly maxHp: number; readonly hits: number; readonly down: boolean } | null;
  readonly challengerId: GameId | null;
  readonly challengerSwings: number;
  readonly selfIsChallenger: boolean;
}

/** Implemented by C in arena-session.ts; PR 0 ships a no-op. */
export interface ArenaSession {
  update(deltaMs: number): void;
  isRingTileWalkable(tileX: number, tileY: number): boolean;
  /** E pressed in the arena. True if consumed. */
  onInteract(): boolean;
  /** Primary click/tap on the canvas in the arena. True if consumed. */
  onPrimary(): boolean;
  frame(): ArenaViewFrame | null;
  destroy(): void;
}
