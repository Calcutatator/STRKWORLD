import { Group } from 'three';
import {
  SANDBOX_MAX_HEIGHT,
  SANDBOX_STEP_HEIGHT,
  type AvatarSpriteKey,
  type Facing,
} from '@strkworld/shared';
import { validateAvatarSprite } from '../avatar-state.js';
import {
  reconcileRemotePeers,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from '../remote-peer.js';
import { avatarFigureHeight } from './avatar-figure.js';
import { PIXELS_PER_UNIT, angleDelta, directionToYaw, facingToYaw } from './coords.js';
import { createCarriedBlock, type CarriedBlock } from './sandbox-view.js';
import { JUMP_HEIGHT, JUMP_TOTAL_MS, REDUCED_JUMP_HEIGHT, jumpLift, jumpPose } from '../jump.js';
import { createJumpShadow, type JumpShadow } from './jump-shadow.js';
import type { AvatarFigure, AvatarFigureFactory, AvatarMotion } from './types.js';

/**
 * Time constant of the critically damped follow of the latest snapshot
 * position (D-086). A walker is drawn twice this far behind the wire — 90 ms,
 * the lag the earlier first-order ease had at 90 — but at an even speed.
 */
export const REMOTE_INTERPOLATION_TIME_CONSTANT_MS = 45;

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

/**
 * A step up onto a block (D-060) is a hop this long that peaks this far above
 * the new level; stepping off falls under this gravity, in world units per
 * second squared. The same numbers drive the local avatar in the presenter.
 */
export const REMOTE_HOP_MS = 190;
export const REMOTE_HOP_PEAK = 0.32;
export const REMOTE_FALL_GRAVITY = 34;

/** A carried block's centre rides this far above its carrier's head. */
export const REMOTE_CARRY_CLEARANCE = 0.36;

/** Below this gap, in World pixels, the ease is finished and lands exactly. */
const SETTLE_DISTANCE_PX = 0.1;

/** ...provided it is also this slow, in World px per ms (1 px/s). */
const SETTLE_SPEED_PX_PER_MS = 0.001;

/** A rise this tall is a block, and hops. Anything lower (a kerb) eases up. */
const MIN_HOP_RISE = 0.5;

/**
 * A rise taller than one step cannot be walked (D-060 makes it a wall), so it
 * only happens when the stacks under a standing peer arrive after the peer
 * does. The figure lands at once instead of hopping several blocks.
 */
const MAX_HOP_RISE = SANDBOX_STEP_HEIGHT + 0.5;

/** Kerbs ease up with this time constant, as the local avatar's do. */
const KERB_TIME_CONSTANT_MS = 45;

/** Height differences below this, in world units, are finished. */
const SETTLE_HEIGHT = 0.001;

// The wire carries no sprint flag, so remote figures only ever walk. Shared
// frozen values keep the per-frame loop free of allocations.
const WALKING: AvatarMotion = Object.freeze({ moving: true, sprinting: false });
const STANDING: AvatarMotion = Object.freeze({ moving: false, sprinting: false });

export interface RemoteAvatarLayer3DOptions {
  readonly source?: RemotePeerSource;
  readonly figures: AvatarFigureFactory;
  /**
   * Ground height under a World-unit point (raised pavement, sandbox stacks),
   * so feet stand on the surface. Presentation only; absent means flat ground.
   * Changes animate: a block's rise hops, a kerb eases, a drop falls.
   */
  readonly surfaceHeight?: (x: number, z: number) => number;
  /** Builds the block a peer carries overhead; the sandbox view's by default. */
  readonly carriedBlocks?: (colour: number | null) => CarriedBlock;
  /**
   * D-097: whether the player asked for less motion, read as each peer's jump
   * starts: a smaller hop, and the body keeps its shape.
   */
  readonly reducedMotion?: () => boolean;
  /** Builds a jumping peer's contact shadow; the shared one by default. */
  readonly jumpShadows?: () => JumpShadow;
}

export interface RemoteAvatarLayer3D {
  /** Parent group; the engine adds it to the scene. */
  readonly group: Group;
  /** Hide or show every remote figure at once (rooms and the Studio hide them). */
  setVisible(visible: boolean): void;
  /** Per-frame: interpolation, yaw smoothing, heights, figure animation. */
  update(deltaMs: number): void;
  /** Unsubscribe and retire every figure, once. Inert afterwards. */
  destroy(): void;
}

interface RemoteAvatar {
  readonly id: string;
  readonly figure: AvatarFigure;
  /** The look the figure last accepted; a failed setLook leaves it for retry. */
  look: AvatarSpriteKey;
  /** Displayed position, World px. */
  x: number;
  y: number;
  /** Latest snapshot position, World px. */
  targetX: number;
  targetY: number;
  /** Drawn velocity, World px per ms: the follow carries it between snapshots. */
  vx: number;
  vy: number;
  facing: Facing;
  yaw: number;
  /** Layer time of the last eased step; -Infinity while standing. */
  movedAt: number;
  /** Displayed height of the feet, world units. */
  elevation: number;
  /** Mid-air between surfaces: hopping up onto one, or falling to one. */
  air: 'hop' | 'fall' | null;
  /** Where the hop or fall started, where a hop lands, and its age in ms. */
  airFrom: number;
  airTo: number;
  airElapsed: number;
  /** The block overhead: built on the first carry, then kept (hidden) until retirement. */
  carried: CarriedBlock | null;
  /** The colour the block last accepted; a failed change leaves it for retry. */
  carrying: number | null;
  /**
   * D-097: the jump counter last seen. A change plays a jump; the first value
   * seen is only a baseline, so a peer met mid-session does not jump on sight.
   */
  jumps: number;
  /** Time since this peer's jump took off, ms, or null on the ground. */
  jumpElapsed: number | null;
  jumpHeight: number;
  jumpSquash: boolean;
  /** Built on the first jump, then kept (hidden) until retirement. */
  jumpShadow: JumpShadow | null;
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
 * jumping to it, turn instead of flipping, hop onto and fall off sandbox
 * stacks, and show the block they carry (D-060).
 *
 * Positions stay in World pixels, the lobby's own units, until they are
 * written to the scene. Nothing here feeds back into gameplay.
 */
export function createRemoteAvatarLayer3D({
  source,
  figures,
  surfaceHeight,
  carriedBlocks = createCarriedBlock,
  reducedMotion,
  jumpShadows = createJumpShadow,
}: RemoteAvatarLayer3DOptions): RemoteAvatarLayer3D {
  const group = new Group();
  group.name = 'remote-avatars';
  const avatars = new Map<string, RemoteAvatar>();
  // A figure whose retirement failed stays owned so the next snapshot can
  // retry it, but it is never handed back to a reappearing peer: that peer
  // gets a fresh figure once the old one is fully retired.
  const failedRemovals = new Map<string, RemoteAvatar>();
  // The frame loop's view of `avatars`. Rebuilt only after membership
  // changes and never mutated in place, so a callback that publishes or
  // destroys mid-frame cannot disturb the pass, and a steady frame allocates
  // nothing.
  let frameAvatars: readonly RemoteAvatar[] | null = null;
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
    // The carried block rides on the figure but is not the figure's to
    // release, so it goes first. Marked released before the call, like the
    // figure below, so a re-entrant teardown cannot dispose it twice.
    const block = avatar.carried;
    if (block !== null) {
      if (block.object.parent === object) attempt(errors, () => object.remove(block.object));
      avatar.carried = null;
      if (!attempt(errors, () => block.dispose())) avatar.carried = block;
    }
    // D-097: the jump shadow lives in the layer's group, not on the figure.
    const shadow = avatar.jumpShadow;
    if (shadow !== null) {
      avatar.jumpShadow = null;
      if (!attempt(errors, () => shadow.dispose())) avatar.jumpShadow = shadow;
    }
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
    return avatar.carried === null && avatar.jumpShadow === null && avatar.disposed && object.parent !== group;
  };

  /**
   * The height a figure should stand at. Rises follow the peer's snapshot
   * position: that one was collision-checked by its owner, so it never
   * overlaps a stack more than a step up, whereas the eased drawn position
   * can cut a corner through a tall one. The drawn position only holds a
   * figure up on an edge its drawn body still overlaps, so stepping off a
   * stack never sinks the feet into it.
   */
  const surfaceGoal = (avatar: RemoteAvatar): number => {
    if (!surfaceHeight) return 0;
    const underPeer = sampleSurface(surfaceHeight, avatar.targetX, avatar.targetY);
    if (avatar.x === avatar.targetX && avatar.y === avatar.targetY) return underPeer;
    const underDrawn = sampleSurface(surfaceHeight, avatar.x, avatar.y);
    return underDrawn > underPeer && underDrawn <= avatar.elevation + SETTLE_HEIGHT
      ? underDrawn
      : underPeer;
  };

  const placeCarried = (avatar: RemoteAvatar, block: CarriedBlock): void => {
    block.object.position.set(0, avatarFigureHeight(avatar.look) + REMOTE_CARRY_CLEARANCE, 0);
  };

  /** Show `colour` overhead (null hides it). Recorded only once it has taken. */
  const showCarried = (avatar: RemoteAvatar, colour: number | null): void => {
    let block = avatar.carried;
    if (block === null) {
      // Built on the first carry, so peers who never carry cost nothing.
      if (colour === null) return;
      block = carriedBlocks(colour);
      if (destroyed) {
        // destroy() ran inside the factory, before this block had an owner.
        block.dispose();
        return;
      }
      // Owned from here on: retire() releases it with the figure.
      avatar.carried = block;
    } else {
      block.setColour(colour);
      if (destroyed) return;
    }
    // An attach that failed before reaching the figure is retried by the
    // next snapshot, which still sees the colour as unrecorded.
    if (block.object.parent !== avatar.figure.object) {
      placeCarried(avatar, block);
      avatar.figure.object.add(block.object);
    }
    avatar.carrying = colour;
  };

  const restyle = (avatar: RemoteAvatar, look: AvatarSpriteKey): void => {
    avatar.figure.setLook(look);
    // Committed only once setLook returns, so a failed change is retried by
    // the next snapshot even if that snapshot repeats this one exactly.
    avatar.look = look;
    // The block rides at the new look's head height.
    if (avatar.carried !== null) placeCarried(avatar, avatar.carried);
  };

  const addAvatar = (id: string, peer: RemotePeerSnapshot, errors: unknown[]): void => {
    // reconcileRemotePeers has already mapped unknown cosmetics to the
    // default; this narrows the type without a cast.
    const look = validateAvatarSprite(peer.sprite);
    const avatar = standingAvatar(id, figures(look), look, peer);
    // A peer first seen mid-session takes its counter as a baseline.
    avatar.jumps = peer.jumps ?? 0;
    // First appearance lands at once on whatever the peer stands on.
    landOn(avatar, surfaceGoal(avatar));
    if (destroyed) {
      // destroy() ran inside the factory or the height query, before this
      // figure had an owner it could see. Retire it here rather than leak it.
      retire(avatar, errors);
      return;
    }
    // Owned before it is attached: `add` dispatches events into foreign code,
    // and a throw or a destroy() from there must still find the figure. An
    // attach that fails before reaching the group is retried by the next
    // snapshot without building a second figure.
    avatars.set(id, avatar);
    frameAvatars = null;
    place(avatar);
    group.add(avatar.figure.object);
    if (destroyed) return;
    const colour = peer.carrying ?? null;
    if (colour !== null) attempt(errors, () => showCarried(avatar, colour));
  };

  const updateAvatar = (avatar: RemoteAvatar, peer: RemotePeerSnapshot, errors: unknown[]): void => {
    // Targets are plain data, set before any callback runs, so a failed
    // restyle below never holds back movement.
    if (retarget(avatar, peer, clock)) {
      // A teleport lands at once: no glide, no hop, no fall. Written now so
      // a frame drawn before the next update shows the landing.
      landOn(avatar, surfaceGoal(avatar));
      if (destroyed) return;
      place(avatar);
    }
    if (avatar.figure.object.parent !== group) {
      group.add(avatar.figure.object);
      if (destroyed) return;
    }
    // Two independent cosmetics: either failing is reported and retried by
    // the next snapshot without holding back the other.
    const look = validateAvatarSprite(peer.sprite);
    if (look !== avatar.look) attempt(errors, () => restyle(avatar, look));
    if (destroyed) return;
    const colour = peer.carrying ?? null;
    if (colour !== avatar.carrying) attempt(errors, () => showCarried(avatar, colour));
    if (destroyed) return;
    const jumps = peer.jumps ?? 0;
    if (jumps !== avatar.jumps) {
      avatar.jumps = jumps;
      startJump(avatar);
    }
  };

  /** D-097: play one jump from where the peer is drawn; a jump mid-air restarts it. */
  const startJump = (avatar: RemoteAvatar): void => {
    let reduced = false;
    try {
      reduced = reducedMotion?.() === true;
    } catch {
      reduced = false;
    }
    avatar.jumpHeight = reduced ? REDUCED_JUMP_HEIGHT : JUMP_HEIGHT;
    avatar.jumpSquash = !reduced;
    avatar.jumpElapsed = 0;
  };

  /** D-097: the peer's jump this frame: lift, pose and shadow. Returns the pose. */
  const stepJump = (avatar: RemoteAvatar, deltaMs: number): AvatarMotion['jump'] => {
    if (avatar.jumpElapsed === null) return null;
    avatar.jumpElapsed += deltaMs;
    const elapsed = avatar.jumpElapsed;
    const pose = jumpPose(elapsed, avatar.jumpSquash);
    const lift = jumpLift(elapsed, avatar.jumpHeight);
    if (elapsed >= JUMP_TOTAL_MS) avatar.jumpElapsed = null;
    avatar.figure.object.position.y = avatar.elevation + lift;
    let shadow = avatar.jumpShadow;
    if (shadow === null && lift > 0) {
      shadow = jumpShadows();
      avatar.jumpShadow = shadow;
      group.add(shadow.object);
    }
    shadow?.place(avatar.x / PIXELS_PER_UNIT, avatar.elevation, avatar.y / PIXELS_PER_UNIT, lift, avatar.jumpHeight);
    return pose;
  };

  const renderSnapshot = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    // The seam is typed, but a custom source can hand over anything at
    // runtime. The source's own validation runs again, so no figure is built
    // for a malformed id or placed off the bounded World plane, and a bad
    // carried colour reads as none.
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
      frameAvatars = null;
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
        else updateAvatar(avatar, peer, errors);
      } catch (error) {
        // Each peer commits step by step (owned before attached, retargeted
        // before restyled, look and colour recorded only on success), so a
        // failure leaves it coherent for the next snapshot to finish, and
        // later peers still render.
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
    frameAvatars = null;
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
      const list = (frameAvatars ??= [...avatars.values()]);
      let errors: unknown[] | undefined;
      for (let index = 0; index < list.length; index += 1) {
        if (destroyed) break;
        const avatar = list[index]!;
        // Skip a figure retired by a callback earlier in this pass.
        if (avatars.get(avatar.id) !== avatar) continue;
        const moving = clock - avatar.movedAt < REMOTE_MOVEMENT_HOLD_MS;
        if (dt > 0) {
          stepGround(avatar, dt, moving);
          const goal = surfaceGoal(avatar);
          if (destroyed) break;
          stepElevation(avatar, dt, goal);
          place(avatar);
        }
        const jump = dt > 0 ? stepJump(avatar, dt) : null;
        if (destroyed) break;
        if (avatar.frozen) continue;
        try {
          avatar.figure.update(
            dt,
            jump ? { moving, sprinting: false, jump } : moving ? WALKING : STANDING,
          );
        } catch (error) {
          // Frozen after one report instead of rethrowing every frame: a
          // figure that always throws would otherwise report 60 times a second
          // and cost every other remote avatar its animation that frame.
          avatar.frozen = true;
          (errors ??= []).push(error);
        }
      }
      if (errors) throwCollected(errors, 'Remote avatar animation failed');
    },
    destroy,
  };
}

/** A new figure: placed where the snapshot says, facing the wire, standing. */
function standingAvatar(
  id: string,
  figure: AvatarFigure,
  look: AvatarSpriteKey,
  peer: RemotePeerSnapshot,
): RemoteAvatar {
  return {
    id,
    figure,
    look,
    x: peer.x,
    y: peer.y,
    targetX: peer.x,
    targetY: peer.y,
    vx: 0,
    vy: 0,
    facing: peer.facing,
    yaw: facingToYaw(peer.facing),
    movedAt: Number.NEGATIVE_INFINITY,
    elevation: 0,
    air: null,
    airFrom: 0,
    airTo: 0,
    airElapsed: 0,
    carried: null,
    carrying: null,
    jumps: 0,
    jumpElapsed: null,
    jumpHeight: JUMP_HEIGHT,
    jumpSquash: true,
    jumpShadow: null,
    frozen: false,
    disposed: false,
  };
}

/**
 * Point an avatar at its newest snapshot; the ease itself happens in
 * `stepGround`. Returns true for a teleport, which has already landed.
 */
function retarget(avatar: RemoteAvatar, peer: RemotePeerSnapshot, now: number): boolean {
  avatar.facing = peer.facing;
  // Only a changed position is a step. The lobby republishes every peer on
  // each 50 ms patch and a walker's step can miss one, so an unchanged entry
  // leaves the walk to its hold rather than idling the figure at once.
  if (peer.x === avatar.targetX && peer.y === avatar.targetY) return false;
  avatar.targetX = peer.x;
  avatar.targetY = peer.y;
  if (Math.hypot(peer.x - avatar.x, peer.y - avatar.y) <= REMOTE_SNAP_DISTANCE_PX) {
    avatar.movedAt = now;
    return false;
  }
  avatar.x = peer.x;
  avatar.y = peer.y;
  avatar.vx = 0;
  avatar.vy = 0;
  avatar.yaw = facingToYaw(peer.facing);
  avatar.movedAt = Number.NEGATIVE_INFINITY;
  return true;
}

/** Ease one avatar across the ground and turn it, by one frame. */
function stepGround(avatar: RemoteAvatar, deltaMs: number, moving: boolean): void {
  const gapX = avatar.targetX - avatar.x;
  const gapY = avatar.targetY - avatar.y;
  // Face along the ease while walking. With nothing left to ease (it settled
  // early, or the figure is standing), face the way the wire says.
  const goal = (moving ? directionToYaw(gapX, gapY) : null) ?? facingToYaw(avatar.facing);
  const maxTurn = (REMOTE_MAX_TURN_RATE * deltaMs) / 1000;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDelta(avatar.yaw, goal)));
  // Normalised so the yaw stays in (-PI, PI] however long a figure circles.
  avatar.yaw = angleDelta(0, avatar.yaw + turn);
  if (
    Math.hypot(gapX, gapY) <= SETTLE_DISTANCE_PX &&
    Math.hypot(avatar.vx, avatar.vy) <= SETTLE_SPEED_PX_PER_MS
  ) {
    avatar.x = avatar.targetX;
    avatar.y = avatar.targetY;
    avatar.vx = 0;
    avatar.vy = 0;
  } else {
    followAxis(avatar, 'x', avatar.targetX, deltaMs);
    followAxis(avatar, 'y', avatar.targetY, deltaMs);
  }
}

/**
 * One frame of a critically damped follow of `target` along one axis, in its
 * exact closed form, so the result is the same however the time is split
 * into frames. Snapshots arrive as a staircase — a step every 50 ms patch,
 * and a missing step when a move is lost — and a second-order follow carries
 * its velocity across each stair, where a first-order ease slowed down and
 * sped up again within every patch. From rest it never overshoots a target
 * that holds still.
 */
function followAxis(avatar: RemoteAvatar, axis: 'x' | 'y', target: number, deltaMs: number): void {
  const omega = 1 / REMOTE_INTERPOLATION_TIME_CONSTANT_MS;
  const velocityKey = axis === 'x' ? 'vx' : 'vy';
  const error = avatar[axis] - target;
  const velocity = avatar[velocityKey];
  const decay = Math.exp(-omega * deltaMs);
  const drift = velocity + omega * error;
  avatar[axis] = target + (error + drift * deltaMs) * decay;
  avatar[velocityKey] = (velocity - omega * drift * deltaMs) * decay;
}

/** Stand at `height` at once: first appearance, teleports. */
function landOn(avatar: RemoteAvatar, height: number): void {
  avatar.elevation = height;
  avatar.air = null;
}

/**
 * Move the feet towards `goal` by one frame: a block's rise hops, a kerb
 * eases up, any drop falls. Hops and falls are closed-form in their elapsed
 * time, so they are deterministic and frame-rate independent.
 */
function stepElevation(avatar: RemoteAvatar, deltaMs: number, goal: number): void {
  // A hop flies on while its landing holds, and a fall while nothing rises to
  // meet the feet. Anything else re-plans from the current height, so the
  // feet never jump between frames.
  if (avatar.air === 'hop' && goal !== avatar.airTo) avatar.air = null;
  if (avatar.air === 'fall' && goal >= avatar.elevation) avatar.air = null;
  if (avatar.air === null) {
    const rise = goal - avatar.elevation;
    if (rise > MAX_HOP_RISE || Math.abs(rise) <= SETTLE_HEIGHT) {
      avatar.elevation = goal;
      return;
    }
    if (rise > 0 && rise < MIN_HOP_RISE) {
      avatar.elevation += rise * (1 - Math.exp(-deltaMs / KERB_TIME_CONSTANT_MS));
      return;
    }
    avatar.air = rise > 0 ? 'hop' : 'fall';
    avatar.airFrom = avatar.elevation;
    avatar.airTo = goal;
    avatar.airElapsed = 0;
  }
  avatar.airElapsed += deltaMs;
  if (avatar.air === 'hop') {
    const t = avatar.airElapsed / REMOTE_HOP_MS;
    if (t < 1) {
      avatar.elevation = hopHeight(avatar.airFrom, avatar.airTo, t);
      return;
    }
    avatar.elevation = avatar.airTo;
  } else {
    const seconds = avatar.airElapsed / 1000;
    const fallen = avatar.airFrom - 0.5 * REMOTE_FALL_GRAVITY * seconds * seconds;
    if (fallen > goal) {
      avatar.elevation = fallen;
      return;
    }
    avatar.elevation = goal;
  }
  avatar.air = null;
}

/**
 * Height `t` (0..1) of the way through a hop: a parabola from `from` that
 * peaks REMOTE_HOP_PEAK above `to` and lands exactly on it. Only called for
 * rises between MIN_HOP_RISE and MAX_HOP_RISE, so the root is always real.
 */
export function hopHeight(from: number, to: number, t: number): number {
  const rise = to - from;
  // Callers only hop upwards; clamp anyway so a negative rise can never reach
  // the square root and poison the avatar, camera, sun and fog with NaN.
  const curve = rise + 2 * REMOTE_HOP_PEAK + 2 * Math.sqrt(Math.max(0, REMOTE_HOP_PEAK * (rise + REMOTE_HOP_PEAK)));
  return from + (rise + curve) * t - curve * t * t;
}

/** Surface height under a World-pixel point. A throwing or junk answer reads as ground. */
function sampleSurface(
  surfaceHeight: (x: number, z: number) => number,
  xPx: number,
  yPx: number,
): number {
  let height: number;
  try {
    height = surfaceHeight(xPx / PIXELS_PER_UNIT, yPx / PIXELS_PER_UNIT);
  } catch {
    // Queried every frame, so a failure is not reported 60 times a second.
    return 0;
  }
  if (!Number.isFinite(height)) return 0;
  // Bounded like the stacks themselves, so no hop or fall sees a runaway value.
  return Math.max(-SANDBOX_MAX_HEIGHT, Math.min(SANDBOX_MAX_HEIGHT, height));
}

function place(avatar: RemoteAvatar): void {
  // pixelToGround's mapping, written out so the frame loop allocates nothing.
  avatar.figure.object.position.set(
    avatar.x / PIXELS_PER_UNIT,
    avatar.elevation,
    avatar.y / PIXELS_PER_UNIT,
  );
  avatar.figure.object.rotation.y = avatar.yaw;
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
