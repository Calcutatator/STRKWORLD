import type { Facing, GameId, RoofSwingSnapshot } from '@strkworld/shared';
import type { InteractionTarget } from './interaction.js';
import type { SwingCameraShot } from './roof-swing.js';

/**
 * D-131: the Exchange roof's lookout swing, as the World sees it.
 *
 * The same shape as the arena's channel: the Shell supplies it, so the World
 * never imports the lobby. The channel carries two intents out and validated
 * snapshots in; nothing here decides who rides, how long for, or where the
 * rider stands — the lobby does, and every snapshot passes
 * `normalizeRoofSwing` before anyone sees it. No money, name or address is
 * involved anywhere.
 */

/** The World's view of the swing. The Shell supplies it: the lobby when live, the same rules locally when solo. */
export interface RoofSwingChannel {
  swing(): RoofSwingSnapshot | null;
  subscribe(listener: (swing: RoofSwingSnapshot | null) => void): () => void;
  /** This client's presence id (or the solo stand-in), null while unknown. */
  selfId(): GameId | null;
  claim(): void;
  leave(): void;
  /**
   * Optional: the HUD's "Esc to get off", routed through the World so it
   * takes the same path as the key. The Shell calls each listener on a
   * press; with none, it sends the leave itself.
   */
  subscribeLeaves?(listener: () => void): () => void;
}

/** What world-session gives the swing session. */
export interface RoofSwingSessionHost {
  /** The local player's World pixels on the roof and their facing. */
  position(): { readonly x: number; readonly y: number; readonly facing: Facing };
  /** Stand the local player on a roof-local tile, facing a way: the server moved them. */
  placeAt(tile: { readonly x: number; readonly y: number }, facing: Facing): void;
  /** `prefers-reduced-motion`: a gentle sway and a camera that cuts. */
  reducedMotion(): boolean;
  /** The swing's seat mesh, for the press-E cues' edge glow (D-123); null if none. */
  swingObject?(): unknown;
  /** True while a panel or Shell claim owns the keyboard. The session then sends nothing. */
  inputSuspended?(): boolean;
  /** The press-E system's yield, held for the whole ride so nothing else takes E. */
  suspendInteractions?(reason: string): () => void;
  /** Movement's gate: held for the ride, so no key moves the rider off the seat. */
  suspendInput?(reason: string): () => void;
}

/** The swing as a press-E station target (D-117), carrying its seat mesh for the cues. */
export type RoofSwingTarget = InteractionTarget & { readonly object?: unknown };

/** What the view draws this frame. */
export interface RoofSwingViewFrame {
  /** Whether anyone is on it: the seat stops shimmering and the prompt reads IN USE. */
  readonly busy: boolean;
  /** The pendulum's angle this frame, radians; positive swings out over the south edge. */
  readonly angle: number;
  /** The rider's presence id, for the remote layer to put on the seat; null when nobody rides. */
  readonly riderId: GameId | null;
  /** Whether this client is the rider: its avatar and camera go with the seat. */
  readonly selfRiding: boolean;
  /** The rider's camera this frame, or null when this client is not riding. */
  readonly shot: SwingCameraShot | null;
}

export interface RoofSwingSession {
  update(deltaMs: number): void;
  /** One target while the player stands on the approach and is not riding; none otherwise. */
  targets(): readonly RoofSwingTarget[];
  /** Esc, or the HUD's button: get off. True when it took the press. */
  onLeave(): boolean;
  /** What the view draws, or null when there is nothing to draw. */
  frame(): RoofSwingViewFrame | null;
  destroy(): void;
}
