import { describe, expect, it, vi } from 'vitest';
import { createRemotePeerSource, type RemotePeerSnapshot } from './remote-peer.js';
import { createRemoteAvatarLayer } from './remote-avatar-layer.js';

const peer = (overrides: Partial<RemotePeerSnapshot> = {}): RemotePeerSnapshot => ({
  id: 'peer-1',
  x: 40,
  y: 72,
  facing: 'down',
  sprite: 'avatar-1',
  ...overrides,
});

function fakeScene() {
  const objects: Array<ReturnType<typeof fakeImage>> = [];
  const layer = {
    visible: true,
    setDepth: vi.fn(function setDepth(this: typeof layer) {
      return this;
    }),
    setVisible: vi.fn(function setVisible(this: typeof layer, visible: boolean) {
      this.visible = visible;
      return this;
    }),
    add: vi.fn(),
    destroy: vi.fn(),
  };
  const scene = {
    add: {
      layer: vi.fn(() => layer),
      image: vi.fn((x: number, y: number, texture: string) => {
        const image = fakeImage(x, y, texture);
        objects.push(image);
        return image;
      }),
    },
    textures: { exists: vi.fn((key: string) => key === 'player') },
    events: { once: vi.fn() },
  };
  return { scene, layer, objects };
}

function fakeImage(x: number, y: number, texture: string) {
  return {
    x,
    y,
    texture: { key: texture },
    visible: true,
    destroyed: false,
    setPosition: vi.fn(function setPosition(this: ReturnType<typeof fakeImage>, nextX: number, nextY: number) {
      this.x = nextX;
      this.y = nextY;
      return this;
    }),
    setTexture: vi.fn(function setTexture(this: ReturnType<typeof fakeImage>, key: string) {
      this.texture.key = key;
      return this;
    }),
    setFlipX: vi.fn(function setFlipX(this: ReturnType<typeof fakeImage>) {
      return this;
    }),
    setFlipY: vi.fn(function setFlipY(this: ReturnType<typeof fakeImage>) {
      return this;
    }),
    setTint: vi.fn(function setTint(this: ReturnType<typeof fakeImage>) {
      return this;
    }),
    setData: vi.fn(function setData(this: ReturnType<typeof fakeImage>) {
      return this;
    }),
    setDepth: vi.fn(function setDepth(this: ReturnType<typeof fakeImage>) {
      return this;
    }),
    setOrigin: vi.fn(function setOrigin(this: ReturnType<typeof fakeImage>) {
      return this;
    }),
    destroy: vi.fn(function destroy(this: ReturnType<typeof fakeImage>) {
      this.destroyed = true;
    }),
  };
}

describe('remote avatar layer', () => {
  it('reconciles a full snapshot into presentation-only images and updates pose', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const image = fake.objects[0]!;

    expect(fake.scene.add.image).toHaveBeenCalledWith(40, 72, 'player');
    expect(fake.layer.add).toHaveBeenCalledWith(image);

    sourceController.publish([peer({ x: 100, y: 120, facing: 'left', sprite: 'avatar-3' })]);
    expect(image.setPosition).toHaveBeenCalledWith(100, 120);
    expect(image.setFlipX).toHaveBeenCalledWith(true);
    expect(image.setData).toHaveBeenCalledWith('facing', 'left');
    expect(image.setTint).toHaveBeenCalled();
    expect(layer.peers.size).toBe(1);
  });

  it('uses the same deterministic tint for each cosy/fighting pair', () => {
    const sourceController = createRemotePeerSource([peer({ sprite: 'avatar-9' })]);
    const fake = fakeScene();
    createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const image = fake.objects[0]!;

    expect(image.setTint).toHaveBeenCalledWith(0xf2e8c9);
    sourceController.publish([peer({ sprite: 'avatar-16' })]);
    expect(image.setTint).toHaveBeenLastCalledWith(0xc7f2df);
  });

  it('removes omitted IDs, clears on empty, and hides the entire layer', () => {
    const sourceController = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });

    sourceController.publish([peer()]);
    expect(fake.objects[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(1);

    layer.setVisible(false);
    expect(fake.layer.setVisible).toHaveBeenCalledWith(false);
    sourceController.publish([]);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(0);
  });

  it('unsubscribes and destroys all presentation objects exactly once', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });

    layer.destroy();
    layer.destroy();
    sourceController.publish([peer({ x: 500 })]);

    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
  });
});
