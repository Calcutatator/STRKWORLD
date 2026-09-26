import { Group } from 'three';
import type { AvatarSpriteKey, Facing } from '@strkworld/shared';
import { validateAvatarSprite } from '../avatar-state.js';
import {
  reconcileRemotePeers,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from '../remote-peer.js';
import {
  PIXELS_PER_UNIT,
  angleDelta,
  directionToYaw,
  facingToYaw,
  pixelToGround,
} from './coords.js';
import type { AvatarFigure, AvatarFigureFactory, AvatarMotion } from './types.js';

/** Time constant of the ease towards the latest snapshot position. */
export const REMOTE_INTERPOLATION_TIME_CONSTANT_MS = 90;

/**
 * A gap wider than this, in World pixels, is a teleport (a room exit, a
 * respawn), not a walk. Gliding across it would drag the figure through
 * walls, so it lands at once instead.
 */
export const REMOTE_SNAP_DISTANCE_PX = 4 * PIXELS_PER_UNIT;

/**
 * How long a figure keeps walking after its last observed step. The 2D layer
 * held one sheet walk cycle: 5 frames at 8 fps for 15 of the 16 sheets.
 */
export const REMOTE_MOVEMENT_HOLD_MS = 625;

/** Fastest turn, in radians per second. */
export const REMOTE_MAX_TURN_RATE = 12;

/** Longest frame simulated in one step. */
export const REMOTE_MAX_FRAME_MS = 250;

/** Below this gap, in World pixels, the ease is finished and lands exactly. */
const SETTLE_DISTANCE_PX = 0.1;

// The wire carries no sprint flag, so remote figures only ever walk. Shared
// frozen values keep the per-frame loop free of allocations.
const WALKING: AvatarMotion = Object.freeze({ moving: true, sprinting: false });
const STANDING: AvatarMotion = Object.freeze({ moving: false, sprinting: false });

export interface RemoteAvatarLayer3DOptions {
  readonly source?: RemotePeerSource;
  readonly figures: AvatarFigureFactory;
  /**
   * Ground height under a World-unit point (raised pavement, for example), so
   * feet stand on the surface. Presentation only; absent means flat ground.
   */
  readonly surfaceHeight?: (x: number, z: number) => number;
}

export interface RemoteAvatarLayer3D {
  /** Parent group; the engine adds it to the scene. */
  readonly group: Group;
  /** Hide or show every remote figure at once (rooms and the Studio hide them). */
  setVisible(visible: boolean): void;
  /** Per-frame: interpolation, yaw smoothing, figure animation. */
  update(deltaMs: number): void;
  /** Unsubscribe and retire every figure, once. Inert afterwards. */
  destroy(): void;
}

interface RemoteAvatar {
  readonly figure: AvatarFigure;
  /** The look the figure last accepted; a failed setLook leaves it for retry. */
  look: AvatarSpriteKey;
  /** Displayed position, World px. */
  x: number;
  y: number;
  /** Latest snapshot position, World px. */
  targetX: number;
  targetY: number;
  facing: Facing;
  yaw: number;
  /** Layer time of the last eased step; -Infinity while standing. */
  movedAt: number;
  /** Set once figure.update has thrown: the figure stops animating, the loop does not. */
  frozen: boolean;
  /** Set while dispose() runs and once it has returned; cleared if it throws. */
  disposed: boolean;
}

/**
 * Other players in the 3D World (D-059): the Three.js port of the Phaser
 * RemoteAvatarLayer in ../remote-avatar-layer.ts.
 *
 * The lifecycle and failure contract is unchanged. The source replays inside
 * `subscribe`; a snapshot delivered while another is rendering is queued and
 * drained in order; one peer's failure never strands another; and a figure
 * whose retirement failed is retried, never reused. What is new is
 * presentation only: figures ease towards the latest snapshot instead of
 * jumping to it, and turn instead of flipping.
 *
 * Positions stay in World pixels, the lobby's own units, until they are
 * written to the scene through `pixelToGround`. Nothing here feeds back into
 * gameplay.
 */
export function createRemoteAvatarLayer3D({
  source,
  figures,
  surfaceHeight,
}: RemoteAvatarLayer3DOptions): RemoteAvatarLayer3D {
  const group = new Group();
  group.name = 'remote-avatars';
  const avatars = new Map<string, RemoteAvatar>();
  // A figure whose retirement failed stays owned so the next snapshot can
  // retry it, but it is never handed back to a reappearing peer: that peer
  // gets a fresh figure once the old one is fully retired.
  const failedRemovals = new Map<string, RemoteAvatar>();
  let destroyed = false;
  let unsubscribe: (() => void) | undefined;
  // Layer time: the sum of clamped frame deltas. Movement holds are measured
  // in it rather than wall time, so there are no timers to own or cancel, and
  // a paused engine cannot expire a hold behind the renderer's back.
  let clock = 0;

  /** Detach and dispose one figure; true once nothing of it is left owned. */
  const retire = (avatar: RemoteAvatar, errors: unknown[]): boolean => {
    const { object } = avatar.figure;
    // A plain flag the renderer checks before drawing. Whatever fails below,
    // a retiring figure never presents a stale pose, and the renderer cannot
    // re-upload buffers that dispose() has already released.
    object.visible = false;
    // Three detaches before it dispatches 'removed', so a throwing listener
    // still leaves the object out of the group. Only the parent says whether
    // the detach needs a retry.
    if (object.parent === group) attempt(errors, () => group.remove(object));
    if (!avatar.disposed) {
      // Marked first so a dispose() that re-enters teardown cannot dispose the
      // figure twice; cleared again on failure so a retry disposes it.
      avatar.disposed = true;
      if (!attempt(errors, () => avatar.figure.dispose())) avatar.disposed = false;
    }
    return avatar.disposed && object.parent !== group;
  };

  const addAvatar = (id: string, peer: RemotePeerSnapshot, errors: unknown[]): void => {
    // reconcileRemotePeers has already mapped unknown cosmetics to the
    // default; this narrows the type without a cast.
    const look = validateAvatarSprite(peer.sprite);
    const avatar = standingAvatar(figures(look), look, peer);
    if (destroyed) {
      // destroy() ran inside the factory, before this figure had an owner it
      // could see. Retire it here rather than leak its GPU resources.
      retire(avatar, errors);
      return;
    }
    // Owned before it is attached: `add` dispatches events into foreign code,
    // and a throw or a destroy() from there must still find the figure. An
    // attach that fails before reaching the group is retried by the next
    // snapshot without building a second figure.
    avatars.set(id, avatar);
    place(avatar);
    group.add(avatar.figure.object);
  };

  const updateAvatar = (avatar: RemoteAvatar, peer: RemotePeerSnapshot): void => {
    // Targets are plain data, set before any callback runs, so a failed
    // restyle below never holds back movement.
    retarget(avatar, peer, clock);
    if (avatar.figure.object.parent !== group) {
      group.add(avatar.figure.object);
      if (destroyed) return;
    }
    const look = validateAvatarSprite(peer.sprite);
    if (look === avatar.look) return;
    avatar.figure.setLook(look);
    // Committed only once setLook returns, so a failed change is retried by
    // the next snapshot even if that snapshot repeats this one exactly.
    avatar.look = look;
  };

  const renderSnapshot = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    // The seam is typed, but a custom source can hand over anything at
    // runtime. The source's own validation runs again, so no figure is built
    // for a malformed id or placed off the bounded World plane.
    const next = reconcileRemotePeers(snapshot);
    const errors: unknown[] = [];

    // Retry carried-over retirements before retiring newly omitted peers: a
    // retirement that fails now is retried by the next snapshot, not twice in
    // this one.
    for (const [id, avatar] of failedRemovals) {
      if (retire(avatar, errors)) failedRemovals.delete(id);
    }
    for (const [id, avatar] of avatars) {
      if (next.has(id)) continue;
      // Retry-only ownership is taken before the cleanup callbacks run, so a
      // destroy() they trigger still finds this figure.
      avatars.delete(id);
      failedRemovals.set(id, avatar);
      if (retire(avatar, errors)) failedRemovals.delete(id);
    }

    for (const [id, peer] of next) {
      if (destroyed) break;
      // The old figure must finish retiring before a replacement is built.
      if (failedRemovals.has(id)) continue;
      try {
        const avatar = avatars.get(id);
        if (avatar === undefined) addAvatar(id, peer, errors);
        else updateAvatar(avatar, peer);
      } catch (error) {
        // Each peer commits step by step (owned before attached, retargeted
        // before restyled, look recorded only on success), so a failure leaves
        // it coherent for the next snapshot to finish, and later peers still
        // render.
        errors.push(error);
      }
    }
    throwCollected(errors, 'Remote avatar reconciliation failed');
  };

  const pendingRenders: Array<readonly RemotePeerSnapshot[]> = [];
  let rendering = false;
  const render = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    // A source or a figure callback may synchronously deliver a second
    // snapshot while the first is still reconciling. Queue it so the outer
    // render cannot apply an older state over the newer one.
    if (rendering) {
      pendingRenders.push(snapshot);
      return;
    }
    rendering = true;
    pendingRenders.push(snapshot);
    const errors: unknown[] = [];
    try {
      while (!destroyed) {
        const next = pendingRenders.shift();
        if (next === undefined) break;
        try {
          renderSnapshot(next);
        } catch (error) {
          // A newer snapshot queued by the failed render is still
          // authoritative. Finish draining it before reporting the older
          // presentation failure to the source.
          errors.push(error);
        }
      }
    } finally {
      pendingRenders.length = 0;
      rendering = false;
    }
    throwCollected(errors, 'Remote avatar reconciliation failed');
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    pendingRenders.length = 0;
    const errors: unknown[] = [];
    if (unsubscribe) {
      const stop = unsubscribe;
      unsubscribe = undefined;
      attempt(errors, stop);
    }
    // Hidden before any figure callback runs, so whatever fails below, nothing
    // this layer owned draws again.
    group.visible = false;
    // Maps are emptied before any callback runs, so re-entrant code sees a
    // retired layer. Teardown makes one attempt per figure: with no later
    // snapshot to retry on, failures are reported rather than retained.
    const owned = [...avatars.values(), ...failedRemovals.values()];
    avatars.clear();
    failedRemovals.clear();
    for (const avatar of owned) retire(avatar, errors);
    // The engine usually detaches the group first; this covers callers that
    // do not, mirroring the Phaser layer destroying itself.
    attempt(errors, () => group.removeFromParent());
    throwCollected(errors, 'Remote avatar cleanup failed');
  };

  // The group exists before subscribe, so the synchronous replay can build
  // figures before subscribe returns. No caller holds this layer until then,
  // so nothing can destroy it mid-replay.
  if (source) {
    try {
      unsubscribe = source.subscribe(render);
    } catch (error) {
      // The replay may have built figures before it failed, and the caller
      // never receives a handle to retire them. If the source kept the
      // listener anyway, `destroyed` makes it inert.
      try {
        destroy();
      } catch {
        // Preserve the subscribe failure.
      }
      throw error;
    }
  }

  return {
    group,
    setVisible(visible) {
      // A visibility callback that outlives teardown is stale, not an error.
      if (destroyed) return;
      group.visible = visible;
    },
    update(deltaMs) {
      if (destroyed) return;
      const dt = clampFrameDelta(deltaMs);
      clock += dt;
      const errors: unknown[] = [];
      // A copy, because a figure callback may publish (retiring peers) or
      // destroy the layer while the loop runs.
      for (const [id, avatar] of [...avatars]) {
        if (destroyed) break;
        if (avatars.get(id) !== avatar) continue;
        const moving = step(avatar, dt, clock);
        if (surfaceHeight) liftToSurface(avatar.figure.object.position, surfaceHeight);
        if (avatar.frozen) continue;
        try {
          avatar.figure.update(dt, moving ? WALKING : STANDING);
        } catch (error) {
          // Frozen after one report instead of rethrowing every frame: a
          // figure that always throws would otherwise report 60 times a second
          // and cost every other remote avatar its animation that frame.
          avatar.frozen = true;
          errors.push(error);
        }
      }
      throwCollected(errors, 'Remote avatar animation failed');
    },
    destroy,
  };
}

/** A new figure: placed where the snapshot says, facing the wire, standing. */
function standingAvatar(
  figure: AvatarFigure,
  look: AvatarSpriteKey,
  peer: RemotePeerSnapshot,
): RemoteAvatar {
  return {
    figure,
    look,
    x: peer.x,
    y: peer.y,
    targetX: peer.x,
    targetY: peer.y,
    facing: peer.facing,
    yaw: facingToYaw(peer.facing),
    movedAt: Number.NEGATIVE_INFINITY,
    frozen: false,
    disposed: false,
  };
}

/** Point an avatar at its newest snapshot. The ease itself happens in `step`. */
function retarget(avatar: RemoteAvatar, peer: RemotePeerSnapshot, now: number): void {
  avatar.facing = peer.facing;
  // Only a changed position is a step. The lobby republishes every peer on
  // each 50 ms patch and a walker's step can miss one, so an unchanged entry
  // leaves the walk to its hold rather than idling the figure at once.
  if (peer.x === avatar.targetX && peer.y === avatar.targetY) return;
  avatar.targetX = peer.x;
  avatar.targetY = peer.y;
  if (Math.hypot(peer.x - avatar.x, peer.y - avatar.y) > REMOTE_SNAP_DISTANCE_PX) {
    avatar.x = peer.x;
    avatar.y = peer.y;
    avatar.yaw = facingToYaw(peer.facing);
    avatar.movedAt = Number.NEGATIVE_INFINITY;
    // Written now so a frame drawn before the next update shows the landing.
    place(avatar);
  } else {
    avatar.movedAt = now;
  }
}

/** Advance one avatar by one frame. Returns whether it is walking. */
function step(avatar: RemoteAvatar, deltaMs: number, now: number): boolean {
  const moving = now - avatar.movedAt < REMOTE_MOVEMENT_HOLD_MS;
  if (deltaMs <= 0) return moving;
  const gapX = avatar.targetX - avatar.x;
  const gapY = avatar.targetY - avatar.y;
  // Face along the ease while walking. With nothing left to ease (it settled
  // early, or the figure is standing), face the way the wire says.
  const goal = (moving ? directionToYaw(gapX, gapY) : null) ?? facingToYaw(avatar.facing);
  const maxTurn = (REMOTE_MAX_TURN_RATE * deltaMs) / 1000;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDelta(avatar.yaw, goal)));
  // Normalised so the yaw stays in (-PI, PI] however long a figure circles.
  avatar.yaw = angleDelta(0, avatar.yaw + turn);
  if (Math.hypot(gapX, gapY) <= SETTLE_DISTANCE_PX) {
    avatar.x = avatar.targetX;
    avatar.y = avatar.targetY;
  } else {
    // Exponential approach: frame-rate independent, and it never overshoots
    // a target that the next snapshot may already have moved on from.
    const blend = 1 - Math.exp(-deltaMs / REMOTE_INTERPOLATION_TIME_CONSTANT_MS);
    avatar.x += gapX * blend;
    avatar.y += gapY * blend;
  }
  place(avatar);
  return moving;
}

function place(avatar: RemoteAvatar): void {
  const ground = pixelToGround(avatar.x, avatar.y);
  avatar.figure.object.position.set(ground.x, 0, ground.z);
  avatar.figure.object.rotation.y = avatar.yaw;
}

/** Stand a figure on whatever surface is under it; a bad height leaves it on the ground. */
function liftToSurface(
  position: { x: number; y: number; z: number },
  surfaceHeight: (x: number, z: number) => number,
): void {
  let height = 0;
  try {
    height = surfaceHeight(position.x, position.z);
  } catch {
    height = 0;
  }
  position.y = Number.isFinite(height) ? height : 0;
}

function clampFrameDelta(deltaMs: number): number {
  // NaN and negative deltas come from a broken clock, not elapsed time.
  if (!(deltaMs > 0)) return 0;
  // One long stall (a backgrounded tab) must not read as a teleport or a full
  // spin in a single step; the ease finishes over the next few frames.
  return Math.min(deltaMs, REMOTE_MAX_FRAME_MS);
}

/** Run one cleanup step, collecting its failure so later steps still run. */
function attempt(errors: unknown[], action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

function throwCollected(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
