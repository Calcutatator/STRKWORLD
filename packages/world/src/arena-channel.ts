import type { ArenaPhase, ArenaRingSnapshot, Facing, GameId } from '@strkworld/shared';
import type { InteractionTarget } from './interaction.js';

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
  /**
   * D-128 (optional): the block, Q held. `down` raises the guard and false
   * lowers it. Rate-limited on the way out; the server decides. A channel
   * without it has no block, so Q does nothing.
   */
  block?(down: boolean): void;
  /**
   * D-128 (optional): the champion presses E at the emperor's box. The
   * server decides whether they may, and seats them.
   */
  sit?(): void;
  /**
   * D-128 (optional): the HUD's touch BLOCK button, routed through the World
   * like STRIKE, so it takes the same gates and client floor as Q.
   */
  subscribeBlocks?(listener: (down: boolean) => void): () => void;
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
  /**
   * C (optional): the ring gate's mesh in the arena room, handed to the
   * gate's press-E target so the interaction cues can glow it. No floor
   * tiles and no floating prompt are drawn for the gate.
   */
  gateObject?(): unknown;
}

/**
 * C: the ring gate as a press-E station target (D-117): World pixels, room
 * origin included. `object` is the gate's own mesh when the host supplies it
 * (`ArenaSessionHost.gateObject`), for the interaction cues' edge glow; the
 * field follows the interaction system's optional object ref.
 */
export type ArenaGateTarget = InteractionTarget & { readonly object?: unknown };

export interface ArenaViewFrame {
  readonly phase: ArenaPhase;
  readonly gate: 'open' | 'busy';
  readonly dummy: { readonly hp: number; readonly maxHp: number; readonly hits: number; readonly down: boolean } | null;
  readonly challengerId: GameId | null;
  readonly challengerSwings: number;
  readonly selfIsChallenger: boolean;
  /** D-128: the fighter holds a block, as the server says. Spectators draw the stance from it. */
  readonly challengerGuarding: boolean;
  /** D-128, mod 256: the fighter's blocked-hit counter. A change is a "blocked" spark. */
  readonly challengerBlocks: number;
  /** D-128: who may use the emperor's box, or null. */
  readonly championId: GameId | null;
  /** D-128: who is on the throne, drawn seated for everyone in the arena; null for nobody. */
  readonly throneId: GameId | null;
  readonly selfIsChampion: boolean;
  readonly selfOnThrone: boolean;
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
   *
   * D-128: the emperor's box is a second target from the same source, while
   * this client stands at it — SIT (or STAND) for the champion, and the
   * CHAMPION ONLY notice for everyone else. It carries the box's own station
   * id, so the room's affordance shell keeps its shimmer and glow, and the
   * room's own reserved notice stands aside for it (`world-session.ts`).
   */
  gateTargets?(): readonly ArenaGateTarget[];
  /**
   * C (optional), for the press-E system: E as an `InteractionAction`
   * (`{ id: 'arena', priority: 10, run: () => session.onAttack() }`). Attacks
   * only while this client fights; true when it took the press.
   */
  onAttack?(): boolean;
  /**
   * D-128 (optional): Q went down or came up. True when the session took it;
   * it only ever does while this client is fighting. The caller gates on
   * focus and on the World owning the keys; the session gates on the ring.
   */
  onBlock?(down: boolean): boolean;
  frame(): ArenaViewFrame | null;
  destroy(): void;
}
