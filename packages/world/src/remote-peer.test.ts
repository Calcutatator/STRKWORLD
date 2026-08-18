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
      peer({ id: 'bad-sprite', sprite: '' }),
    ]);

    expect([...reconciled.values()]).toEqual([
      peer(),
      peer({ id: 'bad-sprite', sprite: 'avatar-1' }),
    ]);
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
