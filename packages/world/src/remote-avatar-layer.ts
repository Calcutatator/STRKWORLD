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
  readonly visual: AvatarVisualController;
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
  const layer = scene.add.layer().setDepth(9);
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

  const render = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    const next = reconcileRemotePeers(snapshot, peers);
    const errors: unknown[] = [];

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
        } catch (error) {
          errors.push(error);
          continue;
        }
      }
      // Register a newly-created sprite before presentation can call into
      // Phaser. If that first update throws, destroy() and a later snapshot
      // still own the partial avatar instead of creating/leaking another one.
      avatars.set(id, avatar);
      const previous = peers.get(id);
      const moving = previous !== undefined && (previous.x !== peer.x || previous.y !== peer.y);
      try {
        updateAvatar(scene, avatar, peer, moving, () => !destroyed);
      } catch (error) {
        errors.push(error);
      }
    }
    peers = next;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Remote avatar reconciliation failed');
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
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
  scene.events.once('shutdown', destroy);

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
      layer.setVisible(visible);
    },
    destroy,
  };
}

function createAvatar(scene: Scene, layer: Layer, peer: RemotePeerSnapshot): RemoteAvatar {
  const sheet = resolveAvatarSheet(peer.sprite);
  const avatar = scene.add.sprite(peer.x, peer.y, sheet.textureKey, 0);
  avatar.setDepth(9);
  layer.add(avatar);
  return {
    sprite: avatar,
    visual: createAvatarVisualController(avatar, peer.sprite),
  };
}

function updateAvatar(
  scene: Scene,
  avatar: RemoteAvatar,
  peer: RemotePeerSnapshot,
  moving: boolean,
  isAlive: () => boolean,
): void {
  cancelIdle(avatar);
  avatar.sprite.setPosition(peer.x, peer.y);
  avatar.visual.present({
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
    avatar.visual.present({
      sprite: peer.sprite,
      facing: peer.facing,
      moving: false,
      sprinting: false,
    });
  });
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
