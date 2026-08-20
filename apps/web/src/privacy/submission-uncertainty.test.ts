import { describe, expect, it, vi } from 'vitest';
import { createSubmissionUncertainty } from './submission-uncertainty.js';

describe('submission uncertainty', () => {
  it('retains one session flag without retaining financial context', () => {
    const uncertainty = createSubmissionUncertainty();
    const changed = vi.fn();
    uncertainty.store.subscribe(changed);

    expect(uncertainty.store.getState()).toEqual({ active: false, acknowledged: false });
    uncertainty.retain();

    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
    expect(changed).toHaveBeenCalledOnce();
    expect(Object.keys(uncertainty.store.getState())).toEqual(['active', 'acknowledged']);
  });

  it('is idempotent and exposes no clear operation', () => {
    const uncertainty = createSubmissionUncertainty();
    const changed = vi.fn();
    uncertainty.store.subscribe(changed);

    uncertainty.retain();
    uncertainty.retain();

    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
    expect(changed).toHaveBeenCalledOnce();
    expect('clear' in uncertainty).toBe(false);
  });

  it('does not expose a writable store that can clear retained uncertainty', () => {
    const uncertainty = createSubmissionUncertainty();
    const publicTypeExcludesSetState: 'setState' extends keyof typeof uncertainty.store
      ? false
      : true = true;

    uncertainty.retain();

    expect(publicTypeExcludesSetState).toBe(true);
    expect(Object.keys(uncertainty.store).sort()).toEqual([
      'getServerSnapshot',
      'getState',
      'subscribe',
    ]);
    expect(Reflect.get(uncertainty.store, 'setState')).toBeUndefined();
    expect(Object.isFrozen(uncertainty.store)).toBe(true);
    expect(Reflect.set(uncertainty.store.getState(), 'active', false)).toBe(false);
    expect(Object.isFrozen(uncertainty.store.getState())).toBe(true);
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
    expect(uncertainty.store.getServerSnapshot()).toEqual({
      active: true,
      acknowledged: false,
    });
  });

  it('acknowledges only an active uncertainty and re-locks on a later retain', () => {
    const uncertainty = createSubmissionUncertainty();
    const changed = vi.fn();
    uncertainty.store.subscribe(changed);

    uncertainty.acknowledge();
    expect(uncertainty.store.getState()).toEqual({ active: false, acknowledged: false });
    expect(changed).not.toHaveBeenCalled();

    uncertainty.retain();
    uncertainty.acknowledge();
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: true });

    uncertainty.retain();
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
  });
});
