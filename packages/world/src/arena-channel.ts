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
  /**
   * C (optional): the HUD's STRIKE button, routed through the World so it
   * takes the same path as E and a click (client floor, local swing). The
   * Shell calls each listener on a STRIKE press; with none, it sends the
   * attack itself.
   */
  subscribeStrikes?(listener: () => void): () => void;
}

/** What world-session (A) gives the arena session (C). */
export interface ArenaSessionHost {
  /**
   * The local player's World pixels in the arena room, room origin included
   * (the frame the lobby holds positions in), and facing.
   */
  position(): { readonly x: number; readonly y: number; readonly facing: Facing };
  /** Snap the local player to a tile with the jump choreography (a cut under reduced motion). */
  leapTo(tile: { readonly x: number; readonly y: number }, facing: Facing): void;
  setPrompt(text: string | null): void;
  playLocalSwing(): void;
  setOutfitLocked(locked: boolean): void;
  selectLook(mode: 'fighting' | 'restore'): void;
  reducedMotion(): boolean;
  /**
   * C (optional): true while a panel or Shell claim owns the keyboard. The
   * session then sends nothing, whatever the caller forwards.
   */
  inputSuspended?(): boolean;
  /**
   * C (optional): the press-E system's combat yield (D-117,
   * `interactions.suspend`). When the host supplies it, the session holds a
   * suspension for as long as this client fights, so E goes straight to the
   * attack; and the gate's CLAIM / IN USE prompt comes from `gateTargets`
   * through the interaction system instead of `setPrompt`.
   */
  suspendInteractions?(reason: string): () => void;
}

/**
 * C: the ring gate as a press-E station target (D-117). Structurally the
 * interaction system's `InteractionTarget`: World pixels, room origin included.
 */
export interface ArenaGateTarget {
  readonly id: string;
  readonly label: string;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  activate(): unknown;
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
  /** Arena-local tile indices (the room's own grid, origin excluded). */
  isRingTileWalkable(tileX: number, tileY: number): boolean;
  /** E pressed in the arena. True if consumed. */
  onInteract(): boolean;
  /** Primary click/tap on the canvas in the arena. True if consumed. */
  onPrimary(): boolean;
  /**
   * C (optional), for the press-E system (D-117): the gate as a station,
   * registered as an `InteractionSource` (`{ targets: () => session.gateTargets() }`).
   * One target while this client stands on the gate approach and is not
   * fighting: CLAIM while the ring is idle, IN USE (which does nothing) while
   * it is not. None otherwise.
   */
  gateTargets?(): readonly ArenaGateTarget[];
  /**
   * C (optional), for the press-E system: E as an `InteractionAction`
   * (`{ id: 'arena', priority: 10, run: () => session.onAttack() }`). Attacks
   * only while this client fights; true when it took the press.
   */
  onAttack?(): boolean;
  frame(): ArenaViewFrame | null;
  destroy(): void;
}
