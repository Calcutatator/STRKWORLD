import { describe, expect, it, vi } from 'vitest';
import {
  createRemotePeerSource,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from './remote-peer.js';
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
    destroyed: false,
    setDepth: vi.fn(function setDepth(this: typeof layer) {
      return this;
    }),
    setVisible: vi.fn(function setVisible(this: typeof layer, visible: boolean) {
      if (this.destroyed) throw new Error('layer is destroyed');
      this.visible = visible;
      return this;
    }),
    add: vi.fn(),
    destroy: vi.fn(function destroy(this: typeof layer) {
      this.destroyed = true;
    }),
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
    setVertexRoundMode: vi.fn(function setVertexRoundMode(this: ReturnType<typeof fakeSprite>) {
      return this;
    }),
    destroy: vi.fn(function destroy(this: ReturnType<typeof fakeSprite>) {
      this.destroyed = true;
    }),
  };
}

describe('remote avatar layer', () => {
  it('destroys the layer when initial depth setup fails', () => {
    const fake = fakeScene();
    const error = new Error('depth setup failed');
    fake.layer.setDepth.mockImplementation(() => {
      throw error;
    });

    expect(() => createRemoteAvatarLayer({ scene: fake.scene as never })).toThrow(error);
    expect(fake.layer.destroy).toHaveBeenCalledOnce();
  });

  it('destroys the layer when shutdown-listener registration fails', () => {
    const fake = fakeScene();
    const error = new Error('shutdown listener setup failed');
    fake.scene.events.once.mockImplementation(() => {
      throw error;
    });

    expect(() => createRemoteAvatarLayer({ scene: fake.scene as never })).toThrow(error);
    expect(fake.layer.destroy).toHaveBeenCalledOnce();
  });

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

  it('retains the last rendered peer snapshot when an existing update fails', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const sprite = fake.objects[0]!;
    const updateError = new Error('position update failed');
    sprite.setPosition.mockImplementationOnce(() => {
      throw updateError;
    });

    expect(() => sourceController.publish([peer({ x: 100, y: 120 })])).toThrow(updateError);
    expect(layer.peers.get('peer-1')).toEqual(peer());
    expect(sprite.setPosition).toHaveBeenCalledTimes(2);
  });

  it('commits the newest snapshot after a source reenters during rendering', () => {
    const fake = fakeScene();
    let deliver!: (snapshot: readonly RemotePeerSnapshot[]) => void;
    let reentered = false;
    const source: RemotePeerSource = {
      subscribe(listener) {
        deliver = listener;
        listener([peer({ x: 40 })]);
        return () => undefined;
      },
    };
    const addSprite = fake.scene.add.sprite;
    fake.scene.add.sprite.mockImplementationOnce((x, y, texture, frame) => {
      const sprite = addSprite(x, y, texture, frame);
      sprite.setPosition.mockImplementationOnce(() => {
        if (!reentered) {
          reentered = true;
          deliver([peer({ x: 80 })]);
        }
        return sprite;
      });
      return sprite;
    });

    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source });

    expect(layer.peers.get('peer-1')?.x).toBe(80);
    expect(fake.objects[0]?.x).toBe(80);
  });

  it('drains a queued newer snapshot before rethrowing an older render error', () => {
    const fake = fakeScene();
    let deliver!: (snapshot: readonly RemotePeerSnapshot[]) => void;
    const source: RemotePeerSource = {
      subscribe(listener) {
        deliver = listener;
        listener([peer({ x: 40 })]);
        return () => undefined;
      },
    };
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source });
    const sprite = fake.objects[0]!;
    const renderError = new Error('older render failed');
    sprite.setPosition.mockImplementationOnce(() => {
      deliver([peer({ x: 80 })]);
      throw renderError;
    });

    expect(() => deliver([peer({ x: 56 })])).toThrow(renderError);
    expect(layer.peers.get('peer-1')?.x).toBe(80);
    expect(sprite.x).toBe(80);
  });

  it('does not resurrect retained peers when shutdown destroys during rendering', () => {
    const fake = fakeScene();
    let shutdown!: () => void;
    fake.scene.events.once.mockImplementation((_event, callback) => {
      shutdown = callback;
    });
    const source: RemotePeerSource = {
      subscribe(listener) {
        listener([peer()]);
        return () => undefined;
      },
    };
    const addSprite = fake.scene.add.sprite;
    fake.scene.add.sprite.mockImplementationOnce((x, y, texture, frame) => {
      const sprite = addSprite(x, y, texture, frame);
      sprite.setPosition.mockImplementationOnce(() => {
        shutdown();
        return sprite;
      });
      return sprite;
    });

    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source });

    expect(layer.peers).toEqual(new Map());
  });

  it('retains a new avatar when its first presentation throws, then recovers', () => {
    const sourceController = createRemotePeerSource();
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const presentationError = new Error('first presentation failed');

    fake.scene.add.sprite.mockImplementationOnce((x, y, texture, frame) => {
      const sprite = fakeSprite(x, y, texture);
      sprite.frame = frame;
      fake.objects.push(sprite);
      sprite.setPosition.mockImplementationOnce(() => {
        throw presentationError;
      });
      return sprite;
    });

    expect(() => sourceController.publish([peer()])).toThrow(presentationError);
    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(1);

    expect(() => sourceController.publish([peer()])).not.toThrow();
    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(1);

    layer.destroy();
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('retains a sprite when first visual construction throws before ownership registration', () => {
    const sourceController = createRemotePeerSource();
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const presentationError = new Error('visual construction failed');
    fake.scene.add.sprite.mockImplementationOnce((x, y, texture, frame) => {
      const sprite = fakeSprite(x, y, texture);
      sprite.frame = frame;
      fake.objects.push(sprite);
      sprite.setTexture.mockImplementationOnce(() => {
        throw presentationError;
      });
      return sprite;
    });

    expect(() => sourceController.publish([peer()])).toThrow(presentationError);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(0);

    expect(() => sourceController.publish([peer()])).not.toThrow();
    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(1);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(0);

    layer.destroy();
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back an unknown opaque cosmetic key to avatar-1', () => {
    const sourceController = createRemotePeerSource([
      peer({ facing: 'up', sprite: 'not-allowlisted' }),
    ]);
    const fake = fakeScene();

    createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });

    expect(fake.scene.add.sprite).toHaveBeenCalledWith(40, 72, 'avatar-1', 0);
    expect(fake.objects[0]?.setData).toHaveBeenCalledWith('sprite', 'avatar-1');
    expect(fake.objects[0]?.setFrame).toHaveBeenLastCalledWith(18);
  });

  it('holds remote movement for the active sheet cycle before returning to idle', () => {
    const sourceController = createRemotePeerSource([peer({ sprite: 'avatar-1' })]);
    const fake = fakeScene();

    createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    sourceController.publish([peer({ x: 48, sprite: 'avatar-1' })]);

    expect(fake.scene.time.delayedCall).toHaveBeenLastCalledWith(750, expect.any(Function));
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

  it('ignores visibility updates after the layer has been destroyed', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });

    layer.destroy();

    // A retained Scene callback may arrive after teardown. Visibility is a
    // presentation operation, so it must not call into a destroyed Phaser
    // layer or turn an otherwise harmless stale callback into an exception.
    expect(() => layer.setVisible(false)).not.toThrow();
    expect(fake.layer.setVisible).toHaveBeenCalledTimes(0);
  });

  it('attempts every omitted avatar cleanup before rethrowing one error', () => {
    const sourceController = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const cleanupError = new Error('first sprite cleanup failed');
    fake.objects[0]!.destroy.mockImplementationOnce(() => {
      throw cleanupError;
    });

    expect(() => sourceController.publish([])).toThrow(cleanupError);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.objects[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(0);
    layer.destroy();
  });

  it('aggregates omitted avatar cleanup errors after attempting every peer', () => {
    const sourceController = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    const firstError = new Error('first sprite cleanup failed');
    const secondError = new Error('second sprite cleanup failed');
    fake.objects[0]!.destroy.mockImplementationOnce(() => {
      throw firstError;
    });
    fake.objects[1]!.destroy.mockImplementationOnce(() => {
      throw secondError;
    });

    expect(() => sourceController.publish([])).toThrow(AggregateError);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.objects[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(0);
    layer.destroy();
  });

  it('retries failed removal before creating a replacement for a reappearing ID', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    sourceController.publish([peer({ x: 48 })]);
    const timerError = new Error('timer cleanup failed');
    fake.timers[0]!.remove.mockImplementationOnce(() => {
      throw timerError;
    });

    expect(() => sourceController.publish([])).toThrow(timerError);
    expect(() => sourceController.publish([peer()])).not.toThrow();
    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(2);
    expect(layer.peers.size).toBe(1);

    layer.destroy();
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(2);
    expect(fake.objects[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed removal owned without duplicating on a failed reappearance retry', () => {
    const sourceController = createRemotePeerSource([peer()]);
    const fake = fakeScene();
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source: sourceController.source });
    sourceController.publish([peer({ x: 48 })]);
    const timerError = new Error('timer cleanup remains unavailable');
    fake.timers[0]!.remove.mockImplementation(() => {
      throw timerError;
    });

    expect(() => sourceController.publish([])).toThrow(timerError);
    expect(() => sourceController.publish([peer()])).toThrow(timerError);
    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(1);
    expect(() => layer.destroy()).toThrow(timerError);
  });

  it('owns shutdown when source replay fires before subscribe returns', () => {
    const fake = fakeScene();
    let shutdown: (() => void) | undefined;
    fake.scene.events.once.mockImplementation((_event: string, callback: () => void) => {
      shutdown = callback;
    });
    let deliver: ((snapshot: readonly RemotePeerSnapshot[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const source: RemotePeerSource = {
      subscribe(listener) {
        deliver = listener;
        listener([peer()]);
        shutdown?.();
        return unsubscribe;
      },
    };

    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(0);

    const positionCalls = fake.objects[0]?.setPosition.mock.calls.length;
    deliver?.([peer({ x: 500 })]);
    expect(fake.objects[0]?.setPosition.mock.calls.length).toBe(positionCalls);
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

  it('destroys presentation objects even when source unsubscribe throws', () => {
    const fake = fakeScene();
    const unsubscribe = vi.fn(() => {
      throw new Error('unsubscribe failed');
    });
    const source: RemotePeerSource = {
      subscribe(listener) {
        listener([peer(), peer({ id: 'peer-2' })]);
        return unsubscribe;
      },
    };
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source });

    expect(() => layer.destroy()).toThrow('unsubscribe failed');
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.objects[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(0);
    layer.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
  });

  it('aggregates teardown failures after attempting every owned object', () => {
    const fake = fakeScene();
    const unsubscribe = vi.fn(() => {
      throw new Error('unsubscribe failed');
    });
    const source: RemotePeerSource = {
      subscribe(listener) {
        listener([peer(), peer({ id: 'peer-2' })]);
        return unsubscribe;
      },
    };
    const layer = createRemoteAvatarLayer({ scene: fake.scene as never, source });
    fake.objects[0]!.destroy.mockImplementationOnce(() => {
      throw new Error('sprite failed');
    });

    expect(() => layer.destroy()).toThrow(AggregateError);
    expect(fake.objects[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.objects[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
    expect(layer.peers.size).toBe(0);
    layer.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.layer.destroy).toHaveBeenCalledTimes(1);
  });
});
