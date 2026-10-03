import {
  SWING_APPROACH,
  SWING_INTENT_CLIENT_INTERVAL_MS,
  SWING_RIDE_MS,
  SWING_SEAT_FACING,
  SWING_SEAT_TILE,
  SWING_STEP_OFF_FACING,
  SWING_STEP_OFF_TILE,
  ROOF_PRESENCE_GRID,
  ROOF_SWING_TARGET_ID,
  SWING_FRAME_TILES,
  isOnSwingApproach,
  normalizeRoofSwing,
  type GameId,
  type RoofSwingSnapshot,
} from '@strkworld/shared';
import type {
  RoofSwingChannel,
  RoofSwingSession,
  RoofSwingSessionHost,
  RoofSwingTarget,
  RoofSwingViewFrame,
} from './roof-swing-channel.js';
import { swingAngleAt, swingCameraShot } from './roof-swing.js';

/**
 * D-133: the lookout swing's client session.
 *
 * The World's side of the swing. It reads the swing only from the channel
 * the Shell supplies, and only ever sends the two intents: claim and leave.
 * It never decides who rides or for how long; the ride it animates is the
 * server's round, timed locally from the frame this client first saw it.
 *
 * - **The frame.** On the deck in front of the swing the press-E chip reads
 *   `SWING` while it is free and `IN USE` while it is not, with the seat
 *   mesh as the target so the D-123 cues shimmer and glow it.
 * - **On and off.** A new round whose rider is this client stands the player
 *   on the seat, holds movement and the press-E system for the ride, and
 *   turns the camera south over the edge. The round ending puts them back on
 *   the step-off tile and hands the camera back.
 * - **Esc.** Sends the leave; the server ends the ride and everyone sees it
 *   end. The session never ends its own ride.
 * - **Reduced motion.** A slow shallow sway instead of the arcs, and a still
 *   south-facing shot the rig cuts to rather than sweeps.
 */

/** The chip's words while the swing is free, and while someone is on it. */
export const SWING_LABEL = 'SWING';
export const SWING_BUSY_LABEL = 'IN USE';

/** The A-frame's footprint in World pixels: what a press-E prompt measures to. */
export const SWING_TARGET_RECT = Object.freeze({
  x: ROOF_PRESENCE_GRID.originX + SWING_FRAME_TILES.x * ROOF_PRESENCE_GRID.tileSize,
  y: ROOF_PRESENCE_GRID.originY + SWING_FRAME_TILES.y * ROOF_PRESENCE_GRID.tileSize,
  width: SWING_FRAME_TILES.width * ROOF_PRESENCE_GRID.tileSize,
  height: SWING_FRAME_TILES.height * ROOF_PRESENCE_GRID.tileSize,
});

/** The approach's World pixel rect, for tests and for the session's own check. */
export const SWING_APPROACH_RECT = Object.freeze({
  x: ROOF_PRESENCE_GRID.originX + SWING_APPROACH.x * ROOF_PRESENCE_GRID.tileSize,
  y: ROOF_PRESENCE_GRID.originY + SWING_APPROACH.y * ROOF_PRESENCE_GRID.tileSize,
  width: SWING_APPROACH.width * ROOF_PRESENCE_GRID.tileSize,
  height: SWING_APPROACH.height * ROOF_PRESENCE_GRID.tileSize,
});

export interface RoofSwingSessionOptions {
  /** The clock, ms. `performance.now` by default. */
  readonly now?: () => number;
}

const NO_TARGETS: readonly RoofSwingTarget[] = Object.freeze([]);

export function createRoofSwingSession(
  channel: RoofSwingChannel,
  host: RoofSwingSessionHost,
  options: RoofSwingSessionOptions = {},
): RoofSwingSession {
  const now = options.now ?? (() => globalThis.performance.now());
  let destroyed = false;
  let swing: RoofSwingSnapshot | null = null;
  /** The round this client is riding, or null. */
  let riding: number | null = null;
  /** When this client's ride started, by the local clock. */
  let startedAt = 0;
  /** The angle last handed to the view; kept while nobody rides so the seat settles at rest. */
  let angle = 0;
  let reduced = false;
  /** Reduced motion, re-read about once a second: the setting changes rarely. */
  let reducedAge = Infinity;
  let releaseInteractions: (() => void) | null = null;
  let releaseInput: (() => void) | null = null;
  let lastIntentAt = Number.NEGATIVE_INFINITY;

  const safely = (action: () => void): void => {
    try {
      action();
    } catch {
      // A failing host call must not strand the ride's state machine.
    }
  };

  const selfId = (): GameId | null => {
    try {
      return channel.selfId();
    } catch {
      return null;
    }
  };

  const inputSuspended = (): boolean => {
    try {
      return host.inputSuspended?.() === true;
    } catch {
      return true;
    }
  };

  const hold = (on: boolean): void => {
    if (on) {
      if (releaseInteractions === null) {
        try {
          releaseInteractions = host.suspendInteractions?.('swing') ?? null;
        } catch {
          releaseInteractions = null;
        }
      }
      if (releaseInput === null) {
        try {
          releaseInput = host.suspendInput?.('swing') ?? null;
        } catch {
          releaseInput = null;
        }
      }
      return;
    }
    const stations = releaseInteractions;
    releaseInteractions = null;
    if (stations) safely(stations);
    const movement = releaseInput;
    releaseInput = null;
    if (movement) safely(movement);
  };

  const readReduced = (): boolean => {
    try {
      reduced = host.reducedMotion() === true;
    } catch {
      reduced = false;
    }
    reducedAge = 0;
    return reduced;
  };

  const mount = (round: number): void => {
    riding = round;
    startedAt = now();
    readReduced();
    hold(true);
    safely(() => host.placeAt(SWING_SEAT_TILE, SWING_SEAT_FACING));
  };

  const dismount = (place: boolean): void => {
    riding = null;
    angle = 0;
    hold(false);
    if (place) safely(() => host.placeAt(SWING_STEP_OFF_TILE, SWING_STEP_OFF_FACING));
  };

  const selfIsRider = (next: RoofSwingSnapshot | null): boolean => {
    if (next === null || next.phase !== 'riding' || next.riderId === null) return false;
    const self = selfId();
    return self !== null && next.riderId === self;
  };

  const apply = (value: unknown): void => {
    if (destroyed) return;
    let next: RoofSwingSnapshot | null = null;
    try {
      next = normalizeRoofSwing(value);
    } catch {
      next = null;
    }
    swing = next;
    if (selfIsRider(next)) {
      // A round this client did not mount for is a new ride: mount it.
      if (riding !== (next as RoofSwingSnapshot).round) {
        if (riding !== null) dismount(false);
        mount((next as RoofSwingSnapshot).round);
      }
      return;
    }
    // Not (or no longer) the rider: off the seat if this client was on it.
    if (riding !== null) dismount(true);
  };

  let unsubscribe: (() => void) | null = null;
  let unsubscribeLeaves: (() => void) | null = null;
  try {
    unsubscribe = channel.subscribe((value) => apply(value));
  } catch {
    unsubscribe = null;
  }
  try {
    unsubscribeLeaves = channel.subscribeLeaves?.(() => void leave()) ?? null;
  } catch {
    unsubscribeLeaves = null;
  }
  readReduced();
  // `subscribe` may or may not replay; read the current swing either way.
  try {
    if (swing === null) apply(channel.swing());
  } catch {
    apply(null);
  }

  /** Send an intent, at most one per client floor. True when it took the press. */
  const intent = (send: () => void): boolean => {
    const t = now();
    if (t - lastIntentAt < SWING_INTENT_CLIENT_INTERVAL_MS) return true;
    lastIntentAt = t;
    safely(send);
    return true;
  };

  const leave = (): boolean => {
    if (destroyed || riding === null) return false;
    return intent(() => channel.leave());
  };

  const claimTarget: RoofSwingTarget = Object.freeze({
    id: ROOF_SWING_TARGET_ID,
    label: SWING_LABEL,
    rect: SWING_TARGET_RECT,
    activate: () => {
      if (destroyed || swing === null || swing.phase !== 'idle' || inputSuspended()) return false;
      return intent(() => channel.claim());
    },
  });
  // IN USE takes the press and does nothing: nothing is sent while it is busy.
  const busyTarget: RoofSwingTarget = Object.freeze({
    id: ROOF_SWING_TARGET_ID,
    label: SWING_BUSY_LABEL,
    rect: SWING_TARGET_RECT,
    activate: () => false,
  });
  const CLAIM_TARGETS: readonly RoofSwingTarget[] = Object.freeze([claimTarget]);
  const BUSY_TARGETS: readonly RoofSwingTarget[] = Object.freeze([busyTarget]);

  const swingObject = (): unknown => {
    try {
      return host.swingObject?.() ?? null;
    } catch {
      return null;
    }
  };

  return Object.freeze({
    update(deltaMs: number): void {
      if (destroyed) return;
      reducedAge += Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
      if (reducedAge >= 1000) readReduced();
      // Only this client's own ride is timed locally; a spectator's seat is
      // drawn from the seconds the server says are left (see `frame`).
      angle = riding === null ? 0 : swingAngleAt(now() - startedAt, reduced);
    },
    targets(): readonly RoofSwingTarget[] {
      if (destroyed || swing === null || riding !== null) return NO_TARGETS;
      let at: { x: number; y: number } | null = null;
      try {
        at = host.position();
      } catch {
        at = null;
      }
      if (at === null || !isOnSwingApproach(at.x, at.y)) return NO_TARGETS;
      const targets = swing.phase === 'idle' ? CLAIM_TARGETS : BUSY_TARGETS;
      const object = swingObject();
      // With the seat's mesh the cues glow it; the target is otherwise the same.
      return object == null ? targets : [{ ...(targets[0] as RoofSwingTarget), object }];
    },
    onLeave(): boolean {
      return leave();
    },
    frame(): RoofSwingViewFrame | null {
      if (destroyed || swing === null) return null;
      const self = riding !== null;
      // A spectator's seat follows the same timeline from the seconds the
      // server has left to run, so everyone sees roughly the same arc.
      const theirs = !self && swing.phase === 'riding'
        ? swingAngleAt(SWING_RIDE_MS - swing.secondsLeft * 1000, reduced)
        : 0;
      return Object.freeze({
        busy: swing.phase !== 'idle',
        angle: self ? angle : theirs,
        riderId: swing.riderId,
        selfRiding: self,
        shot: self ? swingCameraShot(angle, reduced) : null,
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      safely(() => unsubscribe?.());
      safely(() => unsubscribeLeaves?.());
      unsubscribe = null;
      unsubscribeLeaves = null;
      riding = null;
      angle = 0;
      hold(false);
      swing = null;
    },
  });
}
