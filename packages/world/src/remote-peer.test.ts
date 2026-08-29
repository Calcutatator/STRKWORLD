import { describe, expect, it, vi } from 'vitest';
import {
  createRemotePeerSource,
  reconcileRemotePeers,
  type RemotePeerSnapshot,
} from './remote-peer.js';

const peer = (overrides: Partial<RemotePeerSnapshot> = {}): RemotePeerSnapshot => ({
  id: 'peer-1',
  x: 40,
  y: 72,
  facing: 'down',
  sprite: 'avatar-1',
  ...overrides,
});

describe('RemotePeerSource', () => {
  it('replays the latest immutable full snapshot synchronously', () => {
    const source = createRemotePeerSource([peer()]).source;
    const seen: Array<readonly RemotePeerSnapshot[]> = [];
    const listener = vi.fn((snapshot: readonly RemotePeerSnapshot[]) => {
      seen.push(snapshot);
    });

    source.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual([peer()]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.[0])).toBe(true);
    expect('publish' in source).toBe(false);
  });

  it('publishes full replacement snapshots, including an authoritative clear', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const seen: Array<readonly RemotePeerSnapshot[]> = [];
    source.subscribe((snapshot) => seen.push(snapshot));

    controller.publish([peer(), peer({ id: 'peer-2', x: 80 })]);
    controller.publish([peer({ x: 96 })]);
    controller.publish([]);

    expect(seen).toEqual([
      [],
      [peer(), peer({ id: 'peer-2', x: 80 })],
      [peer({ x: 96 })],
      [],
    ]);
  });

  it('makes unsubscribe idempotent and stops later delivery', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    unsubscribe();
    unsubscribe();
    controller.publish([peer()]);

    expect(listener).toHaveBeenCalledTimes(1); // the synchronous replay only
  });

  it('rolls back a subscription whose synchronous replay throws', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const error = new Error('replay failed');
    const failed = vi.fn(() => {
      throw error;
    });

    let thrown: unknown;
    try {
      source.subscribe(failed);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);

    const healthy = vi.fn();
    source.subscribe(healthy);
    healthy.mockClear();

    expect(() => controller.publish([peer({ x: 96 })])).not.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledWith([peer({ x: 96 })]);
  });

  it('keeps a same-function replacement created during a failed replay', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const error = new Error('outer replay failed');
    let replaceDuringReplay = true;
    let stopReplacement: (() => void) | undefined;
    const listener = vi.fn(() => {
      if (!replaceDuringReplay) return;
      replaceDuringReplay = false;
      stopReplacement = source.subscribe(listener);
      throw error;
    });

    let thrown: unknown;
    try {
      source.subscribe(listener);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
    listener.mockClear();

    controller.publish([peer({ x: 96 })]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith([peer({ x: 96 })]);

    stopReplacement?.();
    controller.publish([peer({ x: 128 })]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not redeliver a publication to a listener added during publish', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const first = vi.fn();
    const second = vi.fn();
    let publishing = false;

    first.mockImplementation(() => {
      if (publishing) source.subscribe(second);
    });
    source.subscribe(first);

    first.mockClear();
    publishing = true;
    controller.publish([peer()]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith([peer()]);
  });

  it('does not deliver a publication to a listener unsubscribed during publish', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const first = vi.fn();
    const second = vi.fn();
    let unsubscribeSecond: (() => void) | undefined;

    first.mockImplementation(() => {
      unsubscribeSecond?.();
    });
    source.subscribe(first);
    unsubscribeSecond = source.subscribe(second);

    first.mockClear();
    controller.publish([peer()]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1); // the synchronous replay only
  });

  it('does not redeliver to a listener resubscribed during publish', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const first = vi.fn();
    const second = vi.fn();
    let unsubscribeSecond: (() => void) | undefined;
    let resubscribed = false;

    first.mockImplementation((snapshot: readonly RemotePeerSnapshot[]) => {
      if (!resubscribed && snapshot[0]?.x === 1) {
        resubscribed = true;
        unsubscribeSecond?.();
        source.subscribe(second);
      }
    });
    source.subscribe(first);
    unsubscribeSecond = source.subscribe(second);
    first.mockClear();
    second.mockClear();

    controller.publish([peer({ x: 1 })]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith([peer({ x: 1 })]);
  });

  it('does not let a stale unsubscribe remove a replacement subscription', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const listener = vi.fn();
    const unsubscribeFirst = source.subscribe(listener);
    const unsubscribeSecond = source.subscribe(listener);

    listener.mockClear();
    unsubscribeFirst();
    controller.publish([peer()]);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribeSecond();
  });

  it('delivers reentrant publications in arrival order', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    let reentered = false;

    first.mockImplementation((snapshot: readonly RemotePeerSnapshot[]) => {
      if (!reentered && snapshot[0]?.x === 1) {
        reentered = true;
        controller.publish([peer({ x: 2 })]);
        source.subscribe(third);
      }
    });
    source.subscribe(first);
    source.subscribe(second);
    first.mockClear();
    second.mockClear();

    controller.publish([peer({ x: 1 })]);

    expect(first.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      [peer({ x: 1 })],
      [peer({ x: 2 })],
    ]);
    expect(second.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      [peer({ x: 1 })],
      [peer({ x: 2 })],
    ]);
    expect(third.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      [peer({ x: 1 })],
      [peer({ x: 2 })],
    ]);
  });

  it('preserves listener errors and stops the current publication', () => {
    const controller = createRemotePeerSource();
    const source = controller.source;
    const error = new Error('listener failed');
    let shouldThrow = false;
    const first = vi.fn(() => {
      if (shouldThrow) throw error;
    });
    const second = vi.fn();

    source.subscribe(first);
    source.subscribe(second);
    first.mockClear();
    second.mockClear();
    shouldThrow = true;

    expect(() => controller.publish([peer()])).toThrow(error);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('remote peer reconciliation', () => {
  it('validates coordinates, facing and opaque ids, with a safe sprite fallback', () => {
    const reconciled = reconcileRemotePeers([
      peer(),
      peer({ id: 'nan', x: Number.NaN }),
      peer({ id: 'infinite', y: Number.POSITIVE_INFINITY }),
      peer({ id: 'outside', x: 8193 }),
      peer({ id: 'bad-facing', facing: 'diagonal' as never }),
      peer({ id: 'bad id' }),
      peer({ id: 'bad-sprite', sprite: 'avatar-17' }),
    ]);

    expect([...reconciled.values()]).toEqual([
      peer(),
      peer({ id: 'bad-sprite', sprite: 'avatar-1' }),
    ]);
  });

  it('preserves every approved fighting key and falls back for values outside the registry', () => {
    const reconciled = reconcileRemotePeers([
      peer({ id: 'fighting-9', sprite: 'avatar-9' }),
      peer({ id: 'fighting-16', sprite: 'avatar-16' }),
      peer({ id: 'unknown', sprite: 'avatar-17' }),
    ]);

    expect(reconciled.get('fighting-9')?.sprite).toBe('avatar-9');
    expect(reconciled.get('fighting-16')?.sprite).toBe('avatar-16');
    expect(reconciled.get('unknown')?.sprite).toBe('avatar-1');
  });

  it('uses the last occurrence for duplicate ids deterministically', () => {
    const reconciled = reconcileRemotePeers([
      peer({ x: 1 }),
      peer({ x: 2 }),
      peer({ id: 'peer-2', x: 3 }),
    ]);

    expect([...reconciled.values()]).toEqual([peer({ x: 2 }), peer({ id: 'peer-2', x: 3 })]);
  });

  it('replaces the complete authoritative map so omitted ids are removed and [] clears', () => {
    const first = reconcileRemotePeers([peer(), peer({ id: 'peer-2' })]);
    const second = reconcileRemotePeers([peer({ x: 100 })], first);
    const cleared = reconcileRemotePeers([] as const, second);

    expect([...second.values()]).toEqual([peer({ x: 100 })]);
    expect(cleared.size).toBe(0);
  });
});
