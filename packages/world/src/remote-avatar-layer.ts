import type * as PhaserTypes from 'phaser';
import {
  reconcileRemotePeers,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from './remote-peer.js';

type Scene = PhaserTypes.Scene;
type Image = PhaserTypes.GameObjects.Image;
type Layer = PhaserTypes.GameObjects.Layer;

export interface RemoteAvatarLayerOptions {
  readonly scene: Scene;
  readonly source?: RemotePeerSource;
}

export interface RemoteAvatarLayer {
  /** The latest validated full map, useful for deterministic tests/debugging. */
  readonly peers: ReadonlyMap<string, RemotePeerSnapshot>;
  /** Hide/show all remote presentation objects as one layer. */
  setVisible(visible: boolean): void;
  /** Unsubscribe and destroy the layer and all child images, once. */
  destroy(): void;
}

const REMOTE_TINTS: Readonly<Record<string, number>> = {
  'avatar-1': 0xffffff,
  'avatar-2': 0x9fd3ff,
  'avatar-3': 0xffb5b5,
  'avatar-4': 0xb8f0bc,
  'avatar-5': 0xe0c0ff,
  'avatar-6': 0xffdf9b,
  'avatar-7': 0xaee9e4,
  'avatar-8': 0xf4b4dd,
};

/**
 * Phaser-only presentation adapter for the World-owned remote snapshot.
 * Images are deliberately not physics sprites and are never added to a
 * physics group. The scene's local player texture is the only texture key
 * accepted from the snapshot; lobby cosmetic keys only select a tint.
 */
export function createRemoteAvatarLayer({
  scene,
  source,
}: RemoteAvatarLayerOptions): RemoteAvatarLayer {
  const layer = scene.add.layer().setDepth(9);
  const avatars = new Map<string, Image>();
  let peers: ReadonlyMap<string, RemotePeerSnapshot> = new Map();
  let destroyed = false;
  let unsubscribe: (() => void) | undefined;

  const render = (snapshot: readonly RemotePeerSnapshot[]): void => {
    if (destroyed) return;
    const next = reconcileRemotePeers(snapshot, peers);

    for (const [id, avatar] of avatars) {
      if (next.has(id)) continue;
      avatar.destroy();
      avatars.delete(id);
    }

    for (const [id, peer] of next) {
      const avatar = avatars.get(id) ?? createAvatar(scene, layer, peer);
      updateAvatar(avatar, peer);
      avatars.set(id, avatar);
    }
    peers = next;
  };

  // The layer exists before subscribe, so a synchronous replay is safe.
  if (source) unsubscribe = source.subscribe(render);

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const avatar of avatars.values()) avatar.destroy();
    avatars.clear();
    peers = new Map();
    layer.destroy();
  };

  // Scene shutdown is the lifecycle authority. `destroy()` is also exposed
  // for deterministic teardown and is idempotent when both paths run.
  scene.events.once('shutdown', destroy);

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

function createAvatar(scene: Scene, layer: Layer, peer: RemotePeerSnapshot): Image {
  const avatar = scene.add.image(peer.x, peer.y, safeRemoteTexture(scene));
  avatar.setOrigin(0.5, 0.5).setDepth(9);
  layer.add(avatar);
  return avatar;
}

function updateAvatar(avatar: Image, peer: RemotePeerSnapshot): void {
  avatar.setPosition(peer.x, peer.y);
  avatar.setFlipX(peer.facing === 'left');
  avatar.setFlipY(peer.facing === 'up');
  avatar.setTint(REMOTE_TINTS[peer.sprite] ?? 0xffffff);
  avatar.setData('facing', peer.facing);
  avatar.setData('sprite', peer.sprite);
}

/** Never turn the lobby cosmetic key into an arbitrary Phaser texture key. */
function safeRemoteTexture(scene: Scene): string {
  if (scene.textures.exists('player')) return 'player';
  if (!scene.textures.exists('remote-avatar-fallback')) {
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(0xf2e8c9, 1);
    graphics.fillRoundedRect(0, 0, 24, 24, 4);
    graphics.fillStyle(0x2b2b33, 1);
    graphics.fillRect(5, 7, 4, 4);
    graphics.fillRect(15, 7, 4, 4);
    graphics.generateTexture('remote-avatar-fallback', 24, 24);
    graphics.destroy();
  }
  return 'remote-avatar-fallback';
}
