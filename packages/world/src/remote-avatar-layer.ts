import type * as PhaserTypes from 'phaser';
import {
  reconcileRemotePeers,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from './remote-peer.js';
import {
  createAvatarVisualController,
  resolveAvatarAnimation,
  resolveAvatarSheet,
  type AvatarVisualController,
} from './avatar-visual.js';

type Scene = PhaserTypes.Scene;
type Sprite = PhaserTypes.GameObjects.Sprite;
type Layer = PhaserTypes.GameObjects.Layer;
type TimerEvent = PhaserTypes.Time.TimerEvent;

interface RemoteAvatar {
  readonly sprite: Sprite;
  visual?: AvatarVisualController;
  idleTimer?: TimerEvent;
}

export interface RemoteAvatarLayerOptions {
  readonly scene: Scene;
  readonly source?: RemotePeerSource;
}

export interface RemoteAvatarLayer {
  /** The latest validated full map, useful for deterministic tests/debugging. */
  readonly peers: ReadonlyMap<string, RemotePeerSnapshot>;
  /** Hide/show all remote presentation objects as one layer. */
  setVisible(visible: boolean): void;
  /** Unsubscribe and destroy the layer and all child sprites, once. */
  destroy(): void;
}

/**
 * Phaser-only presentation adapter for the World-owned remote snapshot.
 * Sprites are deliberately never given physics bodies or added to a physics
 * group. Opaque lobby cosmetic keys are resolved only through the World-owned
 * final-sheet catalog; directional animation stays presentation-only.
 */
export function createRemoteAvatarLayer({
  scene,
  source,
}: RemoteAvatarLayerOptions): RemoteAvatarLayer {
  const layer = scene.add.layer();
  try {
    layer.setDepth(9);
  } catch (error) {
    // Layer creation transferred ownership to this factory before the first
    // setup call. Preserve the setup error, but do not strand the Phaser layer
    // if that call fails synchronously.
    try {
      layer.destroy();
    } catch {
      // Preserve the original setup failure.
    }
    throw error;
  }
  const avatars = new Map<string, RemoteAvatar>();
  // A child whose removal failed is still owned, but must not be reused if
  // its peer reappears. It is retried separately before a replacement is
  // created, so a destroyed/partially-destroyed child can never be presented.
  const failedRemovals = new Map<string, RemoteAvatar>();
  let peers: ReadonlyMap<string, RemotePeerSnapshot> = new Map();
  let destroyed = false;
  let unsubscribe: (() => void) | undefined;
  let subscribing = false;
  let unsubscribePending = false;

  const renderSnapshot = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    const next = reconcileRemotePeers(snapshot, peers);
    const errors: unknown[] = [];
    const failedUpdates = new Set<string>();

    // Retry failures carried over from an earlier snapshot before processing
    // newly omitted avatars. A newly failed removal is intentionally retried
    // on the next render, not twice in the same reconciliation pass.
    for (const [id, avatar] of failedRemovals) {
      try {
        destroyAvatar(avatar);
        failedRemovals.delete(id);
      } catch (error) {
        errors.push(error);
      }
    }

    for (const [id, avatar] of avatars) {
      if (next.has(id)) continue;
      try {
        destroyAvatar(avatar);
        avatars.delete(id);
      } catch (error) {
        // A failed child cleanup must not prevent later omitted peers from
        // being retired. Move the failed avatar to retry-only ownership so a
        // same-ID peer cannot reuse a destroyed or partially-destroyed child.
        avatars.delete(id);
        failedRemovals.set(id, avatar);
        errors.push(error);
      }
    }

    for (const [id, peer] of next) {
      if (failedRemovals.has(id)) continue;
      let avatar = avatars.get(id);
      if (avatar === undefined) {
        try {
          avatar = createAvatar(scene, layer, peer);
          // Register the sprite before constructing its visual controller.
          // The controller renders immediately, so a Phaser setter can throw
          // before the factory returns. Keeping the partial avatar in the map
          // gives the next snapshot a retry owner and teardown a cleanup owner.
          avatars.set(id, avatar);
        } catch (error) {
          errors.push(error);
          continue;
        }
      }
      if (avatar.visual === undefined) {
        try {
          avatar.visual = createAvatarVisualController(avatar.sprite, peer.sprite);
        } catch (error) {
          errors.push(error);
          continue;
        }
      }
      const previous = peers.get(id);
      const moving = previous !== undefined && (previous.x !== peer.x || previous.y !== peer.y);
      try {
        updateAvatar(scene, avatar, peer, moving, () => !destroyed);
      } catch (error) {
        // Keep the last successfully rendered snapshot authoritative. The
        // source may not publish this exact state again, so committing a
        // failed pose here would make the retained map lie about the sprite
        // and permanently suppress a retry.
        failedUpdates.add(id);
        errors.push(error);
      }
    }
    const rendered = new Map(next);
    for (const id of failedUpdates) {
      const previous = peers.get(id);
      if (previous === undefined) rendered.delete(id);
      else rendered.set(id, previous);
    }
    if (destroyed) return;
    peers = rendered;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Remote avatar reconciliation failed');
  };

  const pendingRenders: Array<readonly RemotePeerSnapshot[]> = [];
  let rendering = false;
  const render = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    // A custom source or presentation callback may synchronously deliver a
    // second snapshot while the first one is still reconciling. Queue it so
    // the outer render cannot commit an older map after the newer presentation
    // has already been applied.
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
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Remote avatar reconciliation failed');
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    pendingRenders.length = 0;
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    };

    attempt(() => scene.events.off('shutdown', destroy));
    if (unsubscribe) {
      const stop = unsubscribe;
      unsubscribe = undefined;
      attempt(stop);
    } else if (subscribing) {
      // A source may replay and trigger shutdown before subscribe() returns
      // its unsubscribe handle. The post-subscribe handoff owns that handle.
      unsubscribePending = true;
    }
    for (const avatar of avatars.values()) attempt(() => destroyAvatar(avatar));
    for (const avatar of failedRemovals.values()) attempt(() => destroyAvatar(avatar));
    avatars.clear();
    failedRemovals.clear();
    peers = new Map();
    attempt(() => layer.destroy());

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Remote avatar cleanup failed');
  };

  // Scene shutdown is the lifecycle authority. `destroy()` is also exposed
  // for deterministic teardown and is idempotent when both paths run.
  try {
    scene.events.once('shutdown', destroy);
  } catch (error) {
    // The layer was created before the Scene lifecycle hook. If registration
    // fails, retire the layer immediately while preserving that setup error.
    try {
      destroy();
    } catch {
      // Preserve the original lifecycle-registration failure.
    }
    throw error;
  }

  // The layer exists before subscribe, so a synchronous replay is safe. The
  // shutdown listener is installed first because replay can run arbitrary
  // presentation code before subscribe() returns.
  if (source) {
    subscribing = true;
    try {
      const stop = source.subscribe(render);
      if (destroyed || unsubscribePending) {
        unsubscribePending = false;
        stop();
      } else {
        unsubscribe = stop;
      }
    } catch (error) {
      if (!destroyed) destroy();
      throw error;
    } finally {
      subscribing = false;
    }
  }

  return {
    get peers() {
      return peers;
    },
    setVisible(visible) {
      if (destroyed) return;
      layer.setVisible(visible);
    },
    destroy,
  };
}

function createAvatar(scene: Scene, layer: Layer, peer: RemotePeerSnapshot): RemoteAvatar {
  const sheet = resolveAvatarSheet(peer.sprite);
  const avatar = scene.add.sprite(peer.x, peer.y, sheet.textureKey, 0);
  try {
    avatar.setDepth(9);
    layer.add(avatar);
  } catch (error) {
    try {
      avatar.destroy();
    } catch {
      // Preserve the construction error; the layer never received ownership.
    }
    throw error;
  }
  return { sprite: avatar };
}

function updateAvatar(
  scene: Scene,
  avatar: RemoteAvatar,
  peer: RemotePeerSnapshot,
  moving: boolean,
  isAlive: () => boolean,
): void {
  const visual = avatar.visual;
  if (visual === undefined) return;
  cancelIdle(avatar);
  const previousX = avatar.sprite.x;
  const previousY = avatar.sprite.y;
  try {
    avatar.sprite.setPosition(peer.x, peer.y);
    visual.present({
      sprite: peer.sprite,
      facing: peer.facing,
      moving,
      sprinting: false,
    });
    if (!moving) return;
    const animation = resolveAvatarAnimation(peer.sprite, peer.facing, false);
    const movementIdleMs = (animation.frames.length / animation.frameRate) * 1_000;
    avatar.idleTimer = scene.time.delayedCall(movementIdleMs, () => {
      avatar.idleTimer = undefined;
      if (!isAlive()) return;
      visual.present({
        sprite: peer.sprite,
        facing: peer.facing,
        moving: false,
        sprinting: false,
      });
    });
  } catch (error) {
    // Position is part of the same presentation commit as the pose. A Phaser
    // setter may mutate coordinates before a later visual/timer operation
    // fails; retain the last-rendered snapshot by compensating only when the
    // coordinates actually changed. Preserve the original failure if the
    // position setter failed before mutating, as common Phaser mocks do.
    if (avatar.sprite.x !== previousX || avatar.sprite.y !== previousY) {
      try {
        avatar.sprite.setPosition(previousX, previousY);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Remote avatar position rollback failed',
        );
      }
    }
    throw error;
  }
}

function cancelIdle(avatar: RemoteAvatar): void {
  avatar.idleTimer?.remove(false);
  avatar.idleTimer = undefined;
}

function destroyAvatar(avatar: RemoteAvatar): void {
  const errors: unknown[] = [];
  const timer = avatar.idleTimer;
  if (timer) {
    try {
      timer.remove(false);
      avatar.idleTimer = undefined;
    } catch (error) {
      // Keep the timer owned when Phaser rejects removal so a later cleanup
      // attempt can retry the same resource instead of silently leaking it.
      errors.push(error);
    }
  }
  try {
    avatar.sprite.destroy();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Remote avatar cleanup failed');
}
