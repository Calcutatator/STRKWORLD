import { Group, type Object3D } from 'three';
import { type Mock, describe, expect, it, vi } from 'vitest';
import { SANDBOX_MAX_HEIGHT, type AvatarSpriteKey } from '@strkworld/shared';
import {
  DEFAULT_REMOTE_SPRITE,
  REMOTE_WORLD_LIMIT,
  createRemotePeerSource,
  type RemotePeerListener,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from '../remote-peer.js';
import { JUMP_AIR_MS, jumpLift } from '../jump.js';
import { avatarFigureHeight } from './avatar-figure.js';
import { angleDelta, facingToYaw, pixelToGround } from './coords.js';
import {
  REMOTE_CARRY_CLEARANCE,
  REMOTE_FALL_GRAVITY,
  REMOTE_HOP_MS,
  REMOTE_HOP_PEAK,
  REMOTE_INTERPOLATION_TIME_CONSTANT_MS,
  REMOTE_MAX_FRAME_MS,
  REMOTE_MAX_TURN_RATE,
  REMOTE_MOVEMENT_HOLD_MS,
  REMOTE_SNAP_DISTANCE_PX,
  createRemoteAvatarLayer3D,
  type RemoteAvatarLayer3D,
} from './remote-avatars.js';
import type { CarriedBlock } from './sandbox-view.js';
import type { AvatarFigure, AvatarMotion } from './types.js';

const WALKING: AvatarMotion = { moving: true, sprinting: false };
const STANDING: AvatarMotion = { moving: false, sprinting: false };

const peer = (overrides: Partial<RemotePeerSnapshot> = {}): RemotePeerSnapshot => ({
  id: 'peer-1',
  x: 40,
  y: 72,
  facing: 'down',
  sprite: 'avatar-1',
  ...overrides,
});

interface FakeFigure {
  readonly object: Group;
  look: AvatarSpriteKey;
  readonly setLook: Mock<(key: AvatarSpriteKey) => void>;
  readonly update: Mock<(deltaMs: number, motion: AvatarMotion) => void>;
  readonly dispose: Mock<() => void>;
}

function fakeFigures() {
  const created: FakeFigure[] = [];
  const build = (key: AvatarSpriteKey): FakeFigure => {
    const figure: FakeFigure = {
      object: new Group(),
      look: key,
      setLook: vi.fn((next: AvatarSpriteKey) => {
        figure.look = next;
      }),
      update: vi.fn<(deltaMs: number, motion: AvatarMotion) => void>(),
      dispose: vi.fn<() => void>(),
    };
    created.push(figure);
    return figure;
  };
  const factory = vi.fn((key: AvatarSpriteKey): AvatarFigure => build(key));
  return { factory, created, build };
}

interface FakeBlock {
  readonly object: Group;
  colour: number | null;
  readonly setColour: Mock<(colour: number | null) => void>;
  readonly dispose: Mock<() => void>;
}

function fakeBlocks() {
  const created: FakeBlock[] = [];
  const build = (colour: number | null): FakeBlock => {
    const block: FakeBlock = {
      object: new Group(),
      colour,
      setColour: vi.fn((next: number | null) => {
        block.colour = next;
      }),
      // The interface does not promise that dispose() detaches, so the layer must.
      dispose: vi.fn<() => void>(),
    };
    created.push(block);
    return block;
  };
  const factory = vi.fn((colour: number | null): CarriedBlock => build(colour));
  return { factory, created, build };
}

/** A surface hook reporting one mutable level everywhere. */
function levelSurface(initial: number) {
  const state = { level: initial };
  const surfaceHeight = vi.fn((_x: number, _z: number): number => state.level);
  return { state, surfaceHeight };
}

function headroom(look: AvatarSpriteKey): number {
  return avatarFigureHeight(look) + REMOTE_CARRY_CLEARANCE;
}

/**
 * A source driven by hand, like a lobby adapter. It deliberately keeps
 * delivering after unsubscribe so tests can prove late snapshots are inert.
 */
function manualSource(initial: readonly RemotePeerSnapshot[] = []) {
  let listener: RemotePeerListener | undefined;
  const unsubscribe = vi.fn<() => void>();
  const source: RemotePeerSource = {
    subscribe(next) {
      listener = next;
      next(initial);
      return unsubscribe;
    },
  };
  return {
    source,
    unsubscribe,
    deliver(snapshot: unknown): void {
      listener?.(snapshot as readonly RemotePeerSnapshot[]);
    },
  };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at index ${index}`);
  return item;
}

/** Run frames of at most `frame` ms until `ms` of layer time has passed. */
function advance(layer: RemoteAvatarLayer3D, ms: number, frame = REMOTE_MAX_FRAME_MS): void {
  for (let remaining = ms; remaining > 0; remaining -= frame) {
    layer.update(Math.min(remaining, frame));
  }
}

/** Long enough for every ease, turn and movement hold to finish. */
function settle(layer: RemoteAvatarLayer3D): void {
  advance(layer, 10_000);
}

function expectAt(figure: FakeFigure, x: number, y: number): void {
  const ground = pixelToGround(x, y);
  expect(figure.object.position.x).toBeCloseTo(ground.x, 10);
  expect(figure.object.position.y).toBe(0);
  expect(figure.object.position.z).toBeCloseTo(ground.z, 10);
}

/** Compare yaws on the circle: PI and -PI are the same heading. */
function expectYaw(figure: FakeFigure, yaw: number): void {
  expect(Math.abs(angleDelta(yaw, figure.object.rotation.y))).toBeLessThan(1e-9);
}

/** Whether the renderer would draw this object: it and every ancestor visible. */
function drawn(object: Object3D): boolean {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

function lastMotion(figure: FakeFigure): AvatarMotion | undefined {
  return figure.update.mock.lastCall?.[1];
}

function thrownBy(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}


/**
 * The share of a gap a critically damped follow (D-086) closes in `ms` from
 * rest, toward a target that holds still: `1 - (1 + t/T) e^(-t/T)`.
 */
function followedFromRest(ms: number): number {
  const t = ms / REMOTE_INTERPOLATION_TIME_CONSTANT_MS;
  return 1 - (1 + t) * Math.exp(-t);
}

describe('remote avatar layer 3D: subscription and reconciliation', () => {
  it('builds figures from the synchronous replay at their ground position and wire facing', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ facing: 'right', sprite: 'avatar-7' })]);

    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith('avatar-7');
    const figure = at(created, 0);
    expect(layer.group.children).toHaveLength(1);
    expect(layer.group.children[0]).toBe(figure.object);
    // First appearance lands exactly, before any frame has run.
    expectAt(figure, 40, 72);
    expectYaw(figure, facingToYaw('right'));
  });

  it('falls back an unknown cosmetic key to the default look, on build and on restyle', () => {
    const { factory, created } = fakeFigures();
    const peers = manualSource([peer({ facing: 'up', sprite: 'not-allowlisted' })]);
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory });

    expect(factory).toHaveBeenCalledWith(DEFAULT_REMOTE_SPRITE);
    expectYaw(at(created, 0), Math.PI);

    peers.deliver([peer({ sprite: 'avatar-3' })]);
    peers.deliver([peer({ sprite: 'still-not-allowlisted' })]);
    expect(at(created, 0).setLook.mock.calls).toEqual([['avatar-3'], [DEFAULT_REMOTE_SPRITE]]);
  });

  it('validates untrusted entries before building anything', () => {
    const { factory, created } = fakeFigures();
    const peers = manualSource();
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });

    peers.deliver([
      null,
      'junk',
      peer({ id: 'bad id!' }),
      peer({ id: 'far', x: REMOTE_WORLD_LIMIT + 1 }),
      peer({ id: 'nan', y: Number.NaN }),
      { ...peer({ id: 'pose' }), facing: 'north' },
      peer({ id: 'twice', x: 64 }),
      peer({ id: 'twice', x: 96 }),
    ]);

    expect(factory).toHaveBeenCalledOnce();
    // Duplicates resolve last-wins, exactly as the source itself does.
    expectAt(at(created, 0), 96, 72);

    // A malformed producer's non-array is an authoritative empty snapshot.
    peers.deliver('not a snapshot');
    expect(at(created, 0).dispose).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);
  });

  it('reconciles full snapshots into one figure per id and restyles it in place', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);

    peers.publish([peer({ x: 100, y: 120, facing: 'left', sprite: 'avatar-3' })]);
    expect(factory).toHaveBeenCalledOnce();
    expect(figure.setLook).toHaveBeenCalledOnce();
    expect(figure.setLook).toHaveBeenCalledWith('avatar-3');

    settle(layer);
    expectAt(figure, 100, 120);
    expectYaw(figure, facingToYaw('left'));

    peers.publish([peer({ x: 100, y: 120, facing: 'left', sprite: 'avatar-3' })]);
    expect(figure.setLook).toHaveBeenCalledOnce();
  });

  it('removes omitted IDs, clears on empty, and hides the whole layer', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const first = at(created, 0);
    const second = at(created, 1);

    peers.publish([peer()]);
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(second.object.parent).toBeNull();
    expect(layer.group.children).toHaveLength(1);

    layer.setVisible(false);
    expect(drawn(first.object)).toBe(false);
    // Peers arriving while the local player is in a room stay hidden too.
    peers.publish([peer(), peer({ id: 'peer-3' })]);
    const third = at(created, 2);
    expect(third.object.parent).toBe(layer.group);
    expect(drawn(third.object)).toBe(false);

    layer.setVisible(true);
    expect(drawn(first.object)).toBe(true);
    expect(drawn(third.object)).toBe(true);

    peers.publish([]);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(third.dispose).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);
  });
});

describe('remote avatar layer 3D: presentation failures', () => {
  it('retries a failed look change on the next snapshot without holding back movement', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);
    const lookError = new Error('look change failed');
    figure.setLook.mockImplementationOnce(() => {
      throw lookError;
    });
    const moved = [peer({ x: 100, sprite: 'avatar-3' }), peer({ id: 'peer-2' })];

    expect(() => peers.publish(moved)).toThrow(lookError);
    // Contained: the later peer is still built and the move still lands.
    expect(factory).toHaveBeenCalledTimes(2);
    settle(layer);
    expectAt(figure, 100, 72);

    // An identical snapshot still carries the uncommitted look, so it retries.
    expect(() => peers.publish(moved)).not.toThrow();
    expect(figure.setLook).toHaveBeenCalledTimes(2);
    expect(figure.setLook).toHaveBeenLastCalledWith('avatar-3');
    peers.publish(moved);
    expect(figure.setLook).toHaveBeenCalledTimes(2);
  });

  it('retries a failed figure build on the next snapshot without stranding other peers', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource();
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const buildError = new Error('figure build failed');
    factory.mockImplementationOnce(() => {
      throw buildError;
    });

    expect(() => peers.publish([peer(), peer({ id: 'peer-2' })])).toThrow(buildError);
    expect(created).toHaveLength(1);

    expect(() => peers.publish([peer(), peer({ id: 'peer-2' })])).not.toThrow();
    expect(created).toHaveLength(2);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('keeps a figure owned when attaching it fails, and retries the attach without rebuilding', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource();
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const attachError = new Error('attach failed');
    const add = vi.spyOn(layer.group, 'add').mockImplementationOnce(() => {
      throw attachError;
    });

    expect(() => peers.publish([peer()])).toThrow(attachError);
    const figure = at(created, 0);
    expect(figure.object.parent).toBeNull();
    expect(figure.dispose).not.toHaveBeenCalled();

    expect(() => peers.publish([peer()])).not.toThrow();
    expect(factory).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledTimes(2);
    expect(figure.object.parent).toBe(layer.group);

    layer.destroy();
    expect(figure.dispose).toHaveBeenCalledOnce();
  });

  it('reports a throwing added listener once, judging attachment by the parent', () => {
    const { factory, created, build } = fakeFigures();
    const peers = createRemotePeerSource();
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const listenerError = new Error('added listener failed');
    factory.mockImplementationOnce((key) => {
      const figure = build(key);
      figure.object.addEventListener('added', () => {
        throw listenerError;
      });
      return figure;
    });
    const add = vi.spyOn(layer.group, 'add');

    // Three attaches before it dispatches 'added', so the figure is in place.
    expect(() => peers.publish([peer()])).toThrow(listenerError);
    expect(at(created, 0).object.parent).toBe(layer.group);
    expect(() => peers.publish([peer({ x: 48 })])).not.toThrow();
    expect(add).toHaveBeenCalledOnce();
  });

  it('attempts every omitted figure cleanup before rethrowing one error', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const cleanupError = new Error('first figure cleanup failed');
    at(created, 0).dispose.mockImplementationOnce(() => {
      throw cleanupError;
    });

    expect(() => peers.publish([])).toThrow(cleanupError);
    expect(at(created, 0).dispose).toHaveBeenCalledOnce();
    expect(at(created, 1).dispose).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);

    // Teardown retries the figure whose dispose failed.
    layer.destroy();
    expect(at(created, 0).dispose).toHaveBeenCalledTimes(2);
    expect(at(created, 1).dispose).toHaveBeenCalledOnce();
  });

  it('aggregates omitted cleanup errors after attempting every peer', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const firstError = new Error('first figure cleanup failed');
    const secondError = new Error('second figure cleanup failed');
    at(created, 0).dispose.mockImplementationOnce(() => {
      throw firstError;
    });
    at(created, 1).dispose.mockImplementationOnce(() => {
      throw secondError;
    });

    const error = thrownBy(() => peers.publish([]));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstError, secondError]);
    expect(layer.group.children).toHaveLength(0);
    expect(() => layer.destroy()).not.toThrow();
  });

  it('retries a failed removal before building a replacement for a reappearing ID', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const old = at(created, 0);
    const cleanupError = new Error('dispose failed');
    old.dispose.mockImplementationOnce(() => {
      throw cleanupError;
    });

    expect(() => peers.publish([])).toThrow(cleanupError);
    expect(() => peers.publish([peer()])).not.toThrow();

    expect(old.dispose).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(2);
    // The old figure finished retiring before its replacement was built.
    expect(old.dispose.mock.invocationCallOrder[1]).toBeLessThan(
      factory.mock.invocationCallOrder[1] ?? 0,
    );
    const replacement = at(created, 1);
    expect(layer.group.children).toHaveLength(1);
    expect(layer.group.children[0]).toBe(replacement.object);

    layer.destroy();
    expect(old.dispose).toHaveBeenCalledTimes(2);
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it('keeps a failed removal owned without duplicating on a failed reappearance retry', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const cleanupError = new Error('dispose remains unavailable');
    at(created, 0).dispose.mockImplementation(() => {
      throw cleanupError;
    });

    expect(() => peers.publish([])).toThrow(cleanupError);
    expect(() => peers.publish([peer()])).toThrow(cleanupError);
    expect(factory).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);
    expect(() => layer.destroy()).toThrow(cleanupError);
  });

  it('hides a figure whose detach fails and retries only the detach', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);
    const detachError = new Error('detach failed');
    const remove = vi.spyOn(layer.group, 'remove').mockImplementationOnce(() => {
      throw detachError;
    });

    expect(() => peers.publish([])).toThrow(detachError);
    // Still attached, but it can never draw, so disposing it was safe.
    expect(figure.object.parent).toBe(layer.group);
    expect(drawn(figure.object)).toBe(false);
    expect(figure.dispose).toHaveBeenCalledOnce();

    expect(() => peers.publish([])).not.toThrow();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(figure.object.parent).toBeNull();
    expect(figure.dispose).toHaveBeenCalledOnce();
  });
});

describe('remote avatar layer 3D: re-entrancy and teardown', () => {
  it('commits the newest snapshot after a source re-enters during rendering', () => {
    const { factory, created, build } = fakeFigures();
    const peers = manualSource([peer({ x: 40 })]);
    factory.mockImplementationOnce((key) => {
      // A synchronous publish from inside presentation code, mid-render.
      peers.deliver([peer({ x: 80 })]);
      return build(key);
    });

    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });

    expect(factory).toHaveBeenCalledOnce();
    settle(layer);
    expectAt(at(created, 0), 80, 72);
  });

  it('drains a queued newer snapshot before rethrowing an older render error', () => {
    const { factory, created } = fakeFigures();
    const peers = manualSource([peer({ x: 40 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);
    const renderError = new Error('older render failed');
    figure.setLook.mockImplementationOnce(() => {
      peers.deliver([peer({ x: 80 })]);
      throw renderError;
    });

    expect(() => peers.deliver([peer({ x: 56, sprite: 'avatar-2' })])).toThrow(renderError);
    settle(layer);
    expectAt(figure, 80, 72);
  });

  it('does not resurrect peers when destroyed during rendering', () => {
    const { factory, created, build } = fakeFigures();
    const peers = manualSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const scene = new Group();
    scene.add(layer.group);
    const first = at(created, 0);
    factory.mockImplementationOnce((key) => {
      // Teardown reached from presentation code while a snapshot renders.
      layer.destroy();
      return build(key);
    });

    expect(() =>
      peers.deliver([peer(), peer({ id: 'peer-2' }), peer({ id: 'peer-3' })]),
    ).not.toThrow();

    const orphan = at(created, 1);
    expect(first.dispose).toHaveBeenCalledOnce();
    // Built after teardown began, so teardown could not see it: retired anyway.
    expect(orphan.dispose).toHaveBeenCalledOnce();
    expect(orphan.object.parent).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(layer.group.children).toHaveLength(0);
    expect(layer.group.parent).toBeNull();

    peers.deliver([peer({ id: 'peer-4' })]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('animates peers that join after the frame loop has started', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    layer.update(16);

    peers.publish([peer(), peer({ id: 'peer-2' })]);
    layer.update(16);

    expect(at(created, 0).update).toHaveBeenCalledTimes(2);
    expect(at(created, 1).update).toHaveBeenCalledOnce();
  });

  it('skips figures retired by a publish from inside the frame loop', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const first = at(created, 0);
    const second = at(created, 1);
    first.update.mockImplementationOnce(() => peers.publish([peer()]));

    layer.update(16);

    expect(second.dispose).toHaveBeenCalledOnce();
    expect(second.update).not.toHaveBeenCalled();
  });

  it('unsubscribes and retires every figure exactly once, then ignores late calls', () => {
    const { factory, created } = fakeFigures();
    const peers = manualSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const scene = new Group();
    scene.add(layer.group);
    const figure = at(created, 0);

    layer.destroy();
    layer.destroy();

    expect(peers.unsubscribe).toHaveBeenCalledOnce();
    expect(figure.dispose).toHaveBeenCalledOnce();
    expect(figure.object.parent).toBeNull();
    expect(layer.group.parent).toBeNull();

    // A source that ignores unsubscribe, a frame loop and a visibility
    // callback that outlive teardown are all inert.
    peers.deliver([peer({ x: 500 }), peer({ id: 'peer-2' })]);
    layer.update(16);
    expect(() => layer.setVisible(true)).not.toThrow();
    expect(factory).toHaveBeenCalledOnce();
    expect(figure.update).not.toHaveBeenCalled();
    expect(layer.group.visible).toBe(false);
    expect(layer.group.children).toHaveLength(0);
  });

  it('retires every figure even when source unsubscribe throws', () => {
    const { factory, created } = fakeFigures();
    const peers = manualSource([peer(), peer({ id: 'peer-2' })]);
    peers.unsubscribe.mockImplementation(() => {
      throw new Error('unsubscribe failed');
    });
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });

    expect(() => layer.destroy()).toThrow('unsubscribe failed');
    expect(at(created, 0).dispose).toHaveBeenCalledOnce();
    expect(at(created, 1).dispose).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);
    layer.destroy();
    expect(peers.unsubscribe).toHaveBeenCalledOnce();
  });

  it('aggregates teardown failures after attempting every owned figure', () => {
    const { factory, created } = fakeFigures();
    const peers = manualSource([peer(), peer({ id: 'peer-2' })]);
    const unsubscribeError = new Error('unsubscribe failed');
    peers.unsubscribe.mockImplementation(() => {
      throw unsubscribeError;
    });
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const disposeError = new Error('figure dispose failed');
    at(created, 0).dispose.mockImplementationOnce(() => {
      throw disposeError;
    });

    const error = thrownBy(() => layer.destroy());
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([unsubscribeError, disposeError]);
    expect(at(created, 1).dispose).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);
    layer.destroy();
    expect(peers.unsubscribe).toHaveBeenCalledOnce();
    expect(at(created, 0).dispose).toHaveBeenCalledOnce();
  });

  it('retires what a failed replay built and rethrows the failure', () => {
    const { factory, created, build } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const buildError = new Error('figure build failed');
    factory
      .mockImplementationOnce((key) => build(key))
      .mockImplementationOnce(() => {
        throw buildError;
      });

    expect(() => createRemoteAvatarLayer3D({ source: peers.source, figures: factory })).toThrow(
      buildError,
    );
    expect(at(created, 0).dispose).toHaveBeenCalledOnce();
    expect(at(created, 0).object.parent).toBeNull();

    // The source dropped the failed subscriber; nothing is listening now.
    peers.publish([peer({ id: 'peer-3' })]);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('remote avatar layer 3D: interpolation', () => {
  it('follows the latest snapshot with a frame-rate-independent critically damped ease (D-086)', () => {
    const run = (frames: readonly number[]) => {
      const { factory, created } = fakeFigures();
      const peers = createRemotePeerSource([peer({ x: 40 })]);
      const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
      const figure = at(created, 0);
      peers.publish([peer({ x: 104 })]);
      // A snapshot moves only the target; the figure has not jumped.
      expectAt(figure, 40, 72);
      for (const frame of frames) layer.update(frame);
      return { layer, figure };
    };

    const coarse = run([90]);
    const fine = run([15, 15, 15, 15, 15, 15]);
    const expected = 40 + 64 * followedFromRest(90);
    expectAt(coarse.figure, expected, 72);
    expectAt(fine.figure, expected, 72);

    settle(coarse.layer);
    expectAt(coarse.figure, 104, 72);
  });

  it('draws a steady walker at an even speed between 50 ms patches (D-086)', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ x: 40 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);
    // 160 px/s, the walk speed: an 8 px step on every patch, drawn at 60 fps.
    const frame = 1000 / 60;
    const speeds: number[] = [];
    let patchAt = 0;
    let x = 40;
    let last = figure.object.position.x;
    for (let t = 0; t < 3000; t += frame) {
      if (t >= patchAt) {
        patchAt += 50;
        x += 8;
        peers.publish([peer({ x })]);
      }
      layer.update(frame);
      const drawn = figure.object.position.x;
      if (t > 1000) speeds.push((drawn - last) / frame);
      last = drawn;
    }
    const mean = speeds.reduce((sum, v) => sum + v, 0) / speeds.length;
    const spread = Math.sqrt(speeds.reduce((sum, v) => sum + (v - mean) ** 2, 0) / speeds.length);
    // The first-order ease this replaced pulsed by 15% on every patch.
    expect(spread / mean).toBeLessThan(0.08);
  });

  it('lands exactly and faces the wire once the ease is imperceptible, even mid-hold', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ facing: 'down' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);

    // One 50 ms walking step east, while the wire reports 'up'.
    peers.publish([peer({ x: 48, facing: 'up' })]);
    advance(layer, 600, 10);

    expect(600).toBeLessThan(REMOTE_MOVEMENT_HOLD_MS);
    expect(lastMotion(figure)).toEqual(WALKING);
    expect(figure.object.position.x).toBe(pixelToGround(48, 72).x);
    expectYaw(figure, facingToYaw('up'));
  });

  it('snaps across a teleport-sized gap and stands, but eases a gap within it', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const jumper = at(created, 0);
    const walker = at(created, 1);

    peers.publish([
      peer({ x: 40 + REMOTE_SNAP_DISTANCE_PX + 1, facing: 'left' }),
      peer({ id: 'peer-2', x: 40 + REMOTE_SNAP_DISTANCE_PX }),
    ]);

    // The teleport lands before any frame runs, already facing the wire.
    expectAt(jumper, 40 + REMOTE_SNAP_DISTANCE_PX + 1, 72);
    expectYaw(jumper, facingToYaw('left'));
    expectAt(walker, 40, 72);

    layer.update(16);
    expect(jumper.update).toHaveBeenLastCalledWith(16, STANDING);
    expect(walker.update).toHaveBeenLastCalledWith(16, WALKING);
    expect(walker.object.position.x).toBeGreaterThan(pixelToGround(40, 72).x);
  });

  it('walks while easing toward a changed target and stands after the movement hold', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);

    layer.update(16);
    expect(figure.update).toHaveBeenLastCalledWith(16, STANDING);

    peers.publish([peer({ x: 48 })]);
    layer.update(16);
    expect(figure.update).toHaveBeenLastCalledWith(16, WALKING);

    advance(layer, REMOTE_MOVEMENT_HOLD_MS - 17);
    expect(lastMotion(figure)).toEqual(WALKING);
    layer.update(1);
    expect(lastMotion(figure)).toEqual(STANDING);
  });

  it('keeps walking through snapshots that repeat an unmoved peer, without extending the hold', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const walker = at(created, 0);

    peers.publish([peer({ x: 48 }), peer({ id: 'peer-2' })]);
    advance(layer, 100);
    // Another peer's step republishes this one unmoved.
    peers.publish([peer({ x: 48 }), peer({ id: 'peer-2', x: 48 })]);
    advance(layer, 100);
    expect(lastMotion(walker)).toEqual(WALKING);

    advance(layer, REMOTE_MOVEMENT_HOLD_MS - 200);
    expect(lastMotion(walker)).toEqual(STANDING);
  });
});

describe('remote avatar layer 3D: yaw and frame deltas', () => {
  it('faces along its motion while walking, then turns to the wire facing', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ facing: 'down' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);

    // Walking east while the wire reports a different last key.
    peers.publish([peer({ x: 40 + 64, facing: 'up' })]);
    layer.update(50);
    expectYaw(figure, (REMOTE_MAX_TURN_RATE * 50) / 1000);
    layer.update(50);
    layer.update(50);
    expectYaw(figure, Math.PI / 2);

    settle(layer);
    expectYaw(figure, facingToYaw('up'));
  });

  it('turns the shortest way round at a bounded rate', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ facing: 'up' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);

    // Standing: up (PI) to left (-PI/2) is a quarter turn through +-PI.
    peers.publish([peer({ facing: 'left' })]);
    layer.update(50);
    expect(angleDelta(facingToYaw('up'), figure.object.rotation.y)).toBeCloseTo(
      (REMOTE_MAX_TURN_RATE * 50) / 1000,
      10,
    );
    expect(Math.abs(figure.object.rotation.y)).toBeLessThanOrEqual(Math.PI);

    settle(layer);
    expectYaw(figure, facingToYaw('left'));
  });

  it('never produces a non-finite pose, whatever the frame deltas', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);
    const hostile = [
      Number.NaN,
      -16,
      0,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e12,
      Number.MIN_VALUE,
      16,
    ];
    const route = [
      peer({ x: 60 }),
      peer({ x: 20, facing: 'left' }),
      peer({ x: 20, y: 100 }),
      peer({ x: REMOTE_WORLD_LIMIT, y: -REMOTE_WORLD_LIMIT, facing: 'up' }),
      peer({ x: REMOTE_WORLD_LIMIT - 10, y: -REMOTE_WORLD_LIMIT, facing: 'right' }),
    ];

    for (const snapshot of route) {
      peers.publish([snapshot]);
      for (const delta of hostile) {
        layer.update(delta);
        const { position, rotation } = figure.object;
        expect([position.x, position.y, position.z, rotation.y].every(Number.isFinite)).toBe(true);
        expect(Math.abs(rotation.y)).toBeLessThanOrEqual(Math.PI);
        const dt = figure.update.mock.lastCall?.[0];
        expect(dt).toBeGreaterThanOrEqual(0);
        expect(dt).toBeLessThanOrEqual(REMOTE_MAX_FRAME_MS);
      }
    }
  });

  it('clamps bad frame deltas before easing and animating', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ x: 40 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);
    peers.publish([peer({ x: 104 })]);

    layer.update(Number.NaN);
    layer.update(-16);
    expect(figure.update.mock.calls.map(([dt]) => dt)).toEqual([0, 0]);
    // A broken clock moves nothing.
    expectAt(figure, 40, 72);

    layer.update(10_000);
    expect(figure.update).toHaveBeenLastCalledWith(REMOTE_MAX_FRAME_MS, WALKING);
    expectAt(figure, 40 + 64 * followedFromRest(REMOTE_MAX_FRAME_MS), 72);
  });

  it('freezes a figure whose animation throws instead of failing every frame', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const broken = at(created, 0);
    const healthy = at(created, 1);
    const animationError = new Error('figure animation failed');
    broken.update.mockImplementation(() => {
      throw animationError;
    });
    peers.publish([peer({ x: 104 }), peer({ id: 'peer-2' })]);

    expect(() => layer.update(16)).toThrow(animationError);
    expect(healthy.update).toHaveBeenCalledOnce();

    expect(() => layer.update(16)).not.toThrow();
    expect(broken.update).toHaveBeenCalledOnce();
    expect(healthy.update).toHaveBeenCalledTimes(2);
    // Only the limbs froze: it is still placed and eased.
    settle(layer);
    expectAt(broken, 104, 72);
  });
});

describe('remote avatar layer 3D: carried blocks (D-060)', () => {
  it('builds a carried block overhead on the first carry, then recolours and hides it in place', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = createRemotePeerSource([peer()]);
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, carriedBlocks: blocks.factory });
    const figure = at(created, 0);
    // Peers who never carry cost nothing.
    expect(blocks.factory).not.toHaveBeenCalled();

    peers.publish([peer({ carrying: 3 })]);
    expect(blocks.factory).toHaveBeenCalledOnce();
    expect(blocks.factory).toHaveBeenCalledWith(3);
    const block = at(blocks.created, 0);
    expect(block.object.parent).toBe(figure.object);
    expect(block.object.position.toArray()).toEqual([0, headroom('avatar-1'), 0]);

    peers.publish([peer({ carrying: null })]);
    peers.publish([peer({ carrying: 5 })]);
    expect(block.setColour.mock.calls).toEqual([[null], [5]]);
    expect(blocks.factory).toHaveBeenCalledOnce();
    expect(block.object.parent).toBe(figure.object);
  });

  it('builds the carried block with the figure when a peer first appears carrying colour 0', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = createRemotePeerSource([peer({ carrying: 0 })]);

    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, carriedBlocks: blocks.factory });

    expect(blocks.factory).toHaveBeenCalledWith(0);
    expect(at(blocks.created, 0).object.parent).toBe(at(created, 0).object);
  });

  it('re-places the carried block at the new head height when the look changes', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = createRemotePeerSource([peer({ carrying: 2 })]);
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, carriedBlocks: blocks.factory });
    const block = at(blocks.created, 0);
    // A shorter build, so the block visibly has to come down.
    expect(headroom('avatar-6')).toBeLessThan(headroom('avatar-1'));

    peers.publish([peer({ carrying: 2, sprite: 'avatar-6' })]);

    expect(at(created, 0).setLook).toHaveBeenCalledWith('avatar-6');
    expect(block.object.position.y).toBe(headroom('avatar-6'));
  });

  it('releases the carried block before its figure, on leaving and on teardown', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = createRemotePeerSource([peer({ carrying: 4 }), peer({ id: 'peer-2', carrying: 1 })]);
    const layer = createRemoteAvatarLayer3D({
      source: peers.source,
      figures: factory,
      carriedBlocks: blocks.factory,
    });

    peers.publish([peer({ id: 'peer-2', carrying: 1 })]);
    layer.destroy();

    for (const index of [0, 1]) {
      const block = at(blocks.created, index);
      const figure = at(created, index);
      expect(block.dispose).toHaveBeenCalledOnce();
      expect(figure.dispose).toHaveBeenCalledOnce();
      expect(block.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        figure.dispose.mock.invocationCallOrder[0] ?? 0,
      );
      expect(block.object.parent).toBeNull();
    }
  });

  it('retries a failed block build or recolour, independently of the look', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = createRemotePeerSource([peer()]);
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, carriedBlocks: blocks.factory });
    const figure = at(created, 0);
    const buildError = new Error('block build failed');
    blocks.factory.mockImplementationOnce(() => {
      throw buildError;
    });

    expect(() => peers.publish([peer({ carrying: 1, sprite: 'avatar-4' })])).toThrow(buildError);
    expect(figure.setLook).toHaveBeenCalledWith('avatar-4');
    expect(() => peers.publish([peer({ carrying: 1, sprite: 'avatar-4' })])).not.toThrow();
    const block = at(blocks.created, 0);
    expect(block.object.parent).toBe(figure.object);

    // Both cosmetics fail in one snapshot: both are attempted and reported.
    block.setColour.mockImplementationOnce(() => {
      throw new Error('recolour failed');
    });
    figure.setLook.mockImplementationOnce(() => {
      throw new Error('look change failed');
    });
    expect(() => peers.publish([peer({ carrying: 6, sprite: 'avatar-5' })])).toThrow(AggregateError);

    // Neither was recorded, so an identical snapshot retries both.
    expect(() => peers.publish([peer({ carrying: 6, sprite: 'avatar-5' })])).not.toThrow();
    expect(block.setColour.mock.calls).toEqual([[6], [6]]);
    expect(figure.setLook).toHaveBeenLastCalledWith('avatar-5');
    expect(block.object.position.y).toBe(headroom('avatar-5'));
  });

  it('keeps a figure whose carried block will not dispose owned, retrying only the block', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = createRemotePeerSource([peer({ carrying: 2 })]);
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, carriedBlocks: blocks.factory });
    const figure = at(created, 0);
    const block = at(blocks.created, 0);
    const disposeError = new Error('block dispose failed');
    block.dispose.mockImplementationOnce(() => {
      throw disposeError;
    });

    expect(() => peers.publish([])).toThrow(disposeError);
    expect(figure.dispose).toHaveBeenCalledOnce();

    // The reappearing peer waits for the old block to be released first.
    expect(() => peers.publish([peer()])).not.toThrow();
    expect(block.dispose).toHaveBeenCalledTimes(2);
    expect(figure.dispose).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('uses the sandbox view carried block by default, hidden again on put-down', () => {
    const { factory, created } = fakeFigures();
    const peers = createRemotePeerSource([peer({ carrying: 2 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory });
    const figure = at(created, 0);

    expect(figure.object.children).toHaveLength(1);
    const block = at(figure.object.children, 0);
    expect(block.visible).toBe(true);
    expect(block.position.y).toBe(headroom('avatar-1'));

    peers.publish([peer({ carrying: null })]);
    expect(block.visible).toBe(false);
    layer.destroy();
    expect(block.parent).toBeNull();
  });

  it('disposes a carried block whose factory destroyed the layer', () => {
    const { factory, created } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = manualSource([peer()]);
    const layer = createRemoteAvatarLayer3D({
      source: peers.source,
      figures: factory,
      carriedBlocks: blocks.factory,
    });
    blocks.factory.mockImplementationOnce((colour) => {
      layer.destroy();
      return blocks.build(colour);
    });

    expect(() => peers.deliver([peer({ carrying: 1 })])).not.toThrow();

    const orphan = at(blocks.created, 0);
    expect(orphan.dispose).toHaveBeenCalledOnce();
    expect(orphan.object.parent).toBeNull();
    expect(at(created, 0).dispose).toHaveBeenCalledOnce();
  });

  it('treats a malformed carried colour from a custom source as none', () => {
    const { factory } = fakeFigures();
    const blocks = fakeBlocks();
    const peers = manualSource();
    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, carriedBlocks: blocks.factory });

    peers.deliver([
      { ...peer(), carrying: 99 },
      { ...peer({ id: 'peer-2' }), carrying: '2' },
      { ...peer({ id: 'peer-3' }), carrying: -1 },
    ]);

    expect(factory).toHaveBeenCalledTimes(3);
    expect(blocks.factory).not.toHaveBeenCalled();
  });
});

describe('remote avatar layer 3D: standing on stacks (D-060)', () => {
  it('stands a first-appearing peer on the surface at once, before any frame', () => {
    const { factory, created } = fakeFigures();
    const surface = levelSurface(3);
    const peers = createRemotePeerSource([peer()]);

    createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight: surface.surfaceHeight });

    expect(at(created, 0).object.position.y).toBe(3);
    // Asked in World units, where the peer stands.
    const ground = pixelToGround(40, 72);
    expect(surface.surfaceHeight).toHaveBeenCalledWith(ground.x, ground.z);
  });

  it('hops up a one-block step, peaking HOP_PEAK above it and landing after HOP_MS', () => {
    const { factory, created } = fakeFigures();
    const surface = levelSurface(0);
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({
      source: peers.source,
      figures: factory,
      surfaceHeight: surface.surfaceHeight,
    });
    const figure = at(created, 0);

    surface.state.level = 1;
    const heights: number[] = [];
    for (let elapsed = 0; elapsed < REMOTE_HOP_MS; elapsed += 5) {
      layer.update(5);
      heights.push(figure.object.position.y);
    }

    expect(Math.max(...heights)).toBeCloseTo(1 + REMOTE_HOP_PEAK, 2);
    expect(Math.max(...heights)).toBeLessThanOrEqual(1 + REMOTE_HOP_PEAK + 1e-9);
    expect(heights.slice(0, -1).every((height) => height > 0 && height !== 1)).toBe(true);
    expect(heights.at(-1)).toBe(1);
  });

  it('carries a peer that climbs mid-jump from the top of its arc onto the block, never dipping (D-106)', () => {
    const { factory, created } = fakeFigures();
    const surface = levelSurface(0);
    const peers = createRemotePeerSource([peer({ jumps: 0 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight: surface.surfaceHeight });
    const figure = at(created, 0);
    layer.update(16);
    peers.publish([peer({ jumps: 1 })]);
    for (let elapsed = 0; elapsed < 200; elapsed += 10) layer.update(10);
    const atClimb = figure.object.position.y;
    expect(atClimb).toBeGreaterThan(0.5);
    surface.state.level = 1;
    let lowest = Number.POSITIVE_INFINITY;
    for (let elapsed = 0; elapsed < 300; elapsed += 10) {
      layer.update(10);
      lowest = Math.min(lowest, figure.object.position.y);
    }
    expect(lowest).toBeGreaterThanOrEqual(atClimb - 0.05);
    for (let elapsed = 0; elapsed < 400; elapsed += 10) layer.update(10);
    expect(figure.object.position.y).toBeCloseTo(1);
  });

  it('plays a peer\'s jump on the same arc as the local one, and carries a climb near the peak on along it onto the block (D-097, D-106)', () => {
    const { factory, created } = fakeFigures();
    const surface = levelSurface(0);
    const peers = createRemotePeerSource([peer({ jumps: 0 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight: surface.surfaceHeight });
    const figure = at(created, 0);
    layer.update(16);
    peers.publish([peer({ jumps: 1 })]);
    let elapsed = 0;
    for (; elapsed < 0.4 * JUMP_AIR_MS; elapsed += 10) {
      layer.update(10);
      expect(figure.object.position.y).toBeCloseTo(jumpLift(elapsed + 10), 5);
    }
    const atClimb = figure.object.position.y;
    expect(atClimb).toBeGreaterThan(1);
    surface.state.level = 1;
    let lowest = Number.POSITIVE_INFINITY;
    for (; elapsed < JUMP_AIR_MS + 40; elapsed += 10) {
      layer.update(10);
      const y = figure.object.position.y;
      lowest = Math.min(lowest, y);
      expect(y).toBeCloseTo(Math.max(1, jumpLift(elapsed + 10)), 5);
    }
    expect(lowest).toBeGreaterThanOrEqual(1 - 1e-9);
    for (let ms = 0; ms < 400; ms += 10) layer.update(10);
    expect(figure.object.position.y).toBeCloseTo(1);
  });

  it('falls off a stack under gravity, frame-rate independent, and lands exactly', () => {
    const fall = (frames: readonly number[]): number => {
      const { factory, created } = fakeFigures();
      const surface = levelSurface(2);
      const peers = createRemotePeerSource([peer()]);
      const layer = createRemoteAvatarLayer3D({
        source: peers.source,
        figures: factory,
        surfaceHeight: surface.surfaceHeight,
      });
      surface.state.level = 0;
      for (const frame of frames) layer.update(frame);
      return at(created, 0).object.position.y;
    };
    const after100ms = 2 - 0.5 * REMOTE_FALL_GRAVITY * 0.1 * 0.1;

    expect(fall([100])).toBeCloseTo(after100ms, 10);
    expect(fall([25, 25, 25, 25])).toBeCloseTo(after100ms, 10);
    // Two blocks take sqrt(2h/g), about 343 ms, and land exactly on the ground.
    expect(fall(Array<number>(40).fill(10))).toBe(0);
  });

  it('holds a figure up while its drawn body still overlaps the stack it steps off', () => {
    const { factory, created } = fakeFigures();
    // One block covers x >= 10 units (320 px).
    const surfaceHeight = (x: number): number => (x >= 10 ? 1 : 0);
    const peers = createRemotePeerSource([peer({ x: 330 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight });
    const figure = at(created, 0);
    expect(figure.object.position.y).toBe(1);

    // The peer's own position is already off the block...
    peers.publish([peer({ x: 300 })]);
    // ...but the eased figure is still over it for a while, so it stays up.
    let framesUp = 0;
    while (figure.object.position.x >= 10 && framesUp < 100) {
      expect(figure.object.position.y).toBe(1);
      layer.update(10);
      framesUp += 1;
    }
    expect(framesUp).toBeGreaterThanOrEqual(3);
    // The frame its drawn body leaves the block, it starts to fall.
    expect(figure.object.position.x).toBeLessThan(10);
    expect(figure.object.position.y).toBeLessThan(1);
  });

  it('never hops onto a stack that only the eased drawn position clips', () => {
    const { factory, created } = fakeFigures();
    // A thin five-block wall between 32 and 64 px that the peer's own positions never touch.
    const surfaceHeight = (x: number): number => (x > 1 && x < 2 ? 5 : 0);
    const peers = createRemotePeerSource([peer({ x: 16 })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight });
    const figure = at(created, 0);

    peers.publish([peer({ x: 80 })]);
    let clipped = false;
    for (let frame = 0; frame < 30; frame += 1) {
      layer.update(10);
      clipped ||= figure.object.position.x > 1 && figure.object.position.x < 2;
      expect(figure.object.position.y).toBe(0);
    }
    expect(clipped).toBe(true);
  });

  it('lands at once on a teleport, and on a rise too tall to be a step', () => {
    const { factory, created } = fakeFigures();
    const flat = { level: 0 };
    // Three blocks high east of 20 units; elsewhere whatever `flat` says.
    const surfaceHeight = (x: number): number => (x >= 20 ? 3 : flat.level);
    const peers = createRemotePeerSource([peer(), peer({ id: 'peer-2' })]);
    const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight });
    const traveller = at(created, 0);
    const stander = at(created, 1);

    peers.publish([peer({ x: 40 + REMOTE_SNAP_DISTANCE_PX + 640 }), peer({ id: 'peer-2' })]);
    expect(traveller.object.position.y).toBe(3);
    layer.update(16);
    expect(traveller.object.position.y).toBe(3);

    // Stacks arriving under a standing peer (a late sandbox snapshot) are no step.
    flat.level = 2;
    layer.update(16);
    expect(stander.object.position.y).toBe(2);
  });

  it('eases up a kerb instead of hopping or popping', () => {
    const { factory, created } = fakeFigures();
    const surface = levelSurface(0);
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({
      source: peers.source,
      figures: factory,
      surfaceHeight: surface.surfaceHeight,
    });
    const figure = at(created, 0);

    surface.state.level = 0.08;
    let previous = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      layer.update(16);
      const height = figure.object.position.y;
      expect(height).toBeGreaterThan(previous);
      expect(height).toBeLessThanOrEqual(0.08);
      if (frame === 0) expect(height).toBeLessThan(0.04);
      previous = height;
      if (height === 0.08) break;
    }
    expect(figure.object.position.y).toBe(0.08);
  });

  it('reads a throwing or junk surface as ground, and never goes non-finite', () => {
    const answers: Array<[() => number, number]> = [
      [
        () => {
          throw new Error('no height here');
        },
        0,
      ],
      [() => Number.NaN, 0],
      [() => Number.POSITIVE_INFINITY, 0],
      [() => 'high' as never, 0],
      [() => 1e308, SANDBOX_MAX_HEIGHT],
      [() => -1e308, -SANDBOX_MAX_HEIGHT],
    ];

    for (const [surfaceHeight, expected] of answers) {
      const { factory, created } = fakeFigures();
      const peers = createRemotePeerSource([peer()]);
      const layer = createRemoteAvatarLayer3D({ source: peers.source, figures: factory, surfaceHeight });
      peers.publish([peer({ x: 60 })]);
      settle(layer);
      expect(at(created, 0).object.position.y).toBe(expected);
    }
  });

  it('re-plans a hop whose landing changes mid-flight without the feet jumping', () => {
    const { factory, created } = fakeFigures();
    const surface = levelSurface(0);
    const peers = createRemotePeerSource([peer()]);
    const layer = createRemoteAvatarLayer3D({
      source: peers.source,
      figures: factory,
      surfaceHeight: surface.surfaceHeight,
    });
    const figure = at(created, 0);
    const track = (frames: number): void => {
      for (let frame = 0; frame < frames; frame += 1) {
        const before = figure.object.position.y;
        layer.update(10);
        expect(Math.abs(figure.object.position.y - before)).toBeLessThan(0.25);
      }
    };

    surface.state.level = 1;
    track(10);
    // Straight on up while still in the air, then off the side mid-hop.
    surface.state.level = 2;
    track(10);
    surface.state.level = 0;
    track(60);
    expect(figure.object.position.y).toBe(0);
  });
});
