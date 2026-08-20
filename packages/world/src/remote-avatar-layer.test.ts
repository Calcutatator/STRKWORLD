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
  const objects: Array<ReturnType<typeof fakeSprite>> = [];
  const timers: Array<ReturnType<typeof fakeTimer>> = [];
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
      sprite: vi.fn((x: number, y: number, texture: string, frame?: number) => {
        const sprite = fakeSprite(x, y, texture);
        sprite.frame = frame;
        objects.push(sprite);
        return sprite;
      }),
    },
    time: {
      delayedCall: vi.fn((delay: number, callback: () => void) => {
        const timer = fakeTimer(delay, callback);
        timers.push(timer);
        return timer;
      }),
    },
    events: { once: vi.fn(), off: vi.fn() },
  };
  return { scene, layer, objects, timers };
}

function fakeTimer(delay: number, callback: () => void) {
  let active = true;
  return {
    delay,
    remove: vi.fn(() => { active = false; }),
    fire() {
      if (!active) return;
      active = false;
      callback();
    },
  };
}

function fakeSprite(x: number, y: number, texture: string) {
  return {
    x,
    y,
    texture: { key: texture },
    visible: true,
    destroyed: false,
    frame: undefined as number | undefined,
    setPosition: vi.fn(function setPosition(this: ReturnType<typeof fakeSprite>, nextX: number, nextY: number) {
      this.x = nextX;
      this.y = nextY;
      return this;
    }),
    setTexture: vi.fn(function setTexture(this: ReturnType<typeof fakeSprite>, key: string) {
      this.texture.key = key;
      return this;
    }),
    play: vi.fn(function play(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    stop: vi.fn(function stop(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    setFrame: vi.fn(function setFrame(this: ReturnType<typeof fakeSprite>, frame: number) {
      this.frame = frame;
      return this;
    }),
    setFlipX: vi.fn(function setFlipX(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    setFlipY: vi.fn(function setFlipY(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    setTint: vi.fn(function setTint(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    setData: vi.fn(function setData(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    setDepth: vi.fn(function setDepth(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    setOrigin: vi.fn(function setOrigin(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    destroy: vi.fn(function destroy(this: ReturnType<typeof fakeSprite>) {
      this.destroyed = true;
    }),
  };
}

describe('remote avatar layer', () => {
  it('renders a validated final sheet on a non-physics sprite at the semantic feet anchor', () => {
    const sourceController = createRemotePeerSource([
      peer({ facing: 'right', sprite: 'avatar-7' }),
    ]);
    const fake = fakeScene();

    createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });

    expect(fake.scene.add.sprite).toHaveBeenCalledWith(40, 72, 'avatar-7', 0);
    const sprite = fake.objects[0]!;
    expect(sprite.setOrigin).toHaveBeenLastCalledWith(0.5, 0.875);
    expect(sprite.setFrame).toHaveBeenLastCalledWith(10);
    expect(sprite).not.toHaveProperty('body');
  });

  it('reconciles a full snapshot into presentation-only sprites and updates pose', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const image = fake.objects[0]!;

    expect(fake.scene.add.sprite).toHaveBeenCalledWith(40, 72, 'avatar-1', 0);
    expect(fake.layer.add).toHaveBeenCalledWith(image);

    sourceController.publish([peer({ x: 100, y: 120, facing: 'left', sprite: 'avatar-3' })]);
    expect(image.setPosition).toHaveBeenCalledWith(100, 120);
    expect(image.play).toHaveBeenLastCalledWith('avatar-3:left:walk', true);
    expect(image.setData).toHaveBeenCalledWith('facing', 'left');
    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(1);
    expect(fake.scene.time.delayedCall).toHaveBeenLastCalledWith(625, expect.any(Function));

    sourceController.publish([peer({ x: 120, y: 120, facing: 'left', sprite: 'avatar-3' })]);
    expect(fake.timers[0]?.remove).toHaveBeenCalledTimes(1);
    fake.timers[0]?.fire();
    expect(image.frame).toBe(0);
    fake.timers[1]?.fire();
    expect(image.setFrame).toHaveBeenLastCalledWith(5);
    expect(layer.peers.size).toBe(1);
  });

  it('falls back an unknown opaque cosmetic key to avatar-1', () => {
    const sourceController = createRemotePeerSource([
      peer({ facing: 'up', sprite: 'not-allowlisted' }),
    ]);
    const fake = fakeScene();

    createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });

    expect(fake.scene.add.sprite).toHaveBeenCalledWith(40, 72, 'avatar-1', 0);
    expect(fake.objects[0]?.setData).toHaveBeenCalledWith('sprite', 'avatar-1');
    expect(fake.objects[0]?.setFrame).toHaveBeenLastCalledWith(15);
  });

  it('renders authored directional frames without placeholder tint or mirroring', () => {
    const sourceController = createRemotePeerSource([
      peer({ facing: 'up', sprite: 'avatar-9' }),
    ]);
    const fake = fakeScene();
    createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const sprite = fake.objects[0]!;

    expect(sprite.setTexture).toHaveBeenLastCalledWith('avatar-9');
    expect(sprite.setFrame).toHaveBeenLastCalledWith(15);
    sourceController.publish([peer({ facing: 'left', sprite: 'avatar-16' })]);
    expect(sprite.setTexture).toHaveBeenLastCalledWith('avatar-16');
    expect(sprite.setFrame).toHaveBeenLastCalledWith(5);
    expect(sprite.setTint).not.toHaveBeenCalled();
    expect(sprite.setFlipX).not.toHaveBeenCalled();
    expect(sprite.setFlipY).not.toHaveBeenCalled();
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
    const shutdown = fake.scene.events.once.mock.calls[0]?.[1];

    sourceController.publish([peer({ x: 500 })]);
    layer.destroy();
    layer.destroy();
    sourceController.publish([peer({ x: 700 })]);

    expect(fake.timers[0]?.remove).toHaveBeenCalledTimes(1);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
    expect(fake.scene.events.off).toHaveBeenCalledWith('shutdown', shutdown);
  });
});
