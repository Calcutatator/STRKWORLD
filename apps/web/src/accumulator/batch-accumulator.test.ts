import { describe, expect, it } from 'vitest';
import type { Intent } from '@strkworld/privacy';
import { createBatchAccumulator } from './batch-accumulator.js';

const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';

const shield = (amount = 5n): Intent => ({ kind: 'shield', token: TOKEN, amount });
const transfer = (amount = 5n): Intent => ({ kind: 'transfer', token: TOKEN, amount, recipient: BOB });
const unshield = (amount = 5n): Intent => ({ kind: 'unshield', token: TOKEN, amount, recipient: BOB });
const swap = (): Intent => ({
  kind: 'swap',
  tokenIn: TOKEN,
  tokenOut: BOB,
  amountIn: 5n,
  minAmountOut: 4n,
});

describe('batch accumulator', () => {
  it('publishes an immutable accumulator API while retaining owned mutation', () => {
    const batch = createBatchAccumulator();
    const originalAccept = batch.accept;

    expect(Object.isFrozen(batch)).toBe(true);
    expect(Reflect.set(batch, 'accept', () => ({ ok: true, value: [] }))).toBe(false);
    expect(Reflect.set(batch, 'confirm', () => ({ ok: true, value: [] }))).toBe(false);
    expect(batch.accept).toBe(originalAccept);
    expect(batch.accept(transfer()).ok).toBe(true);
    expect(batch.confirm().ok).toBe(true);
  });

  it('collects several intents of one kind and emits them as one array', () => {
    const batch = createBatchAccumulator();
    batch.accept(transfer(1n));
    batch.accept(transfer(2n));

    const confirmed = batch.confirm();
    expect(confirmed.ok).toBe(true);
    expect(confirmed.ok && confirmed.value).toHaveLength(2);
  });

  it('refuses a shield and a private spend in one batch (D-022)', () => {
    const batch = createBatchAccumulator();
    expect(batch.accept(shield()).ok).toBe(true);

    const result = batch.accept(transfer());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.rejection.reason).toBe('mixed-shield-and-spend');
    expect(batch.intents).toHaveLength(1);
  });

  it('refuses the same mix in the other order', () => {
    const batch = createBatchAccumulator();
    batch.accept(transfer());
    const result = batch.accept(shield());
    expect(!result.ok && result.rejection.reason).toBe('mixed-shield-and-spend');
  });

  it('keeps one visit to one route kind', () => {
    const batch = createBatchAccumulator();
    batch.accept(transfer());
    const result = batch.accept(unshield());
    expect(!result.ok && result.rejection.reason).toBe('mixed-route-kinds');
  });

  it('settles a swap on its own', () => {
    const batch = createBatchAccumulator();
    batch.accept(swap());
    expect(batch.accept(transfer()).ok).toBe(false);

    const other = createBatchAccumulator();
    other.accept(transfer());
    const result = other.accept(swap());
    expect(!result.ok && result.rejection.reason).toBe('swap-must-be-alone');
  });

  it('rejects an object carrying a protocol target', () => {
    const batch = createBatchAccumulator();
    const smuggled = {
      kind: 'transfer',
      token: TOKEN,
      amount: 1n,
      recipient: BOB,
      contract: '0xdead',
    };

    const result = batch.accept(smuggled);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
    expect(batch.intents).toHaveLength(0);
  });

  it('rejects a raw argument array smuggled onto an intent', () => {
    const batch = createBatchAccumulator();
    const result = batch.accept({
      kind: 'shield',
      token: TOKEN,
      amount: 1n,
      args: ['0x1', '0x2'],
    });
    expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
  });

  it('rejects an unknown intent kind', () => {
    const batch = createBatchAccumulator();
    expect(batch.accept({ kind: 'invoke', contract: '0x1' }).ok).toBe(false);
    expect(batch.accept(null).ok).toBe(false);
    expect(batch.accept('transfer').ok).toBe(false);
  });

  it('does not treat a prototype member as an intent kind', () => {
    // `kind in INTENT_SHAPES` walked the prototype chain, so `toString` passed
    // the kind check and was then indexed into as if it were a field list.
    const batch = createBatchAccumulator();
    for (const kind of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const result = batch.accept({ kind, token: TOKEN, amount: 1n });
      expect(result.ok, kind).toBe(false);
      expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
    }
    expect(batch.intents).toHaveLength(0);
  });

  it('rejects an intent missing a required field', () => {
    const batch = createBatchAccumulator();
    const result = batch.accept({ kind: 'transfer', token: TOKEN, amount: 1n });
    expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
  });

  it('rejects accessor-backed fields without invoking their getters', () => {
    const batch = createBatchAccumulator();
    let reads = 0;
    const accessorIntent = { kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB };
    Object.defineProperty(accessorIntent, 'recipient', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('recipient getter must not run');
      },
    });

    expect(() => batch.accept(accessorIntent)).not.toThrow();
    const result = batch.accept(accessorIntent);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
    expect(reads).toBe(0);
  });

  it('rejects an amount that is not a bigint', () => {
    const batch = createBatchAccumulator();
    const result = batch.accept({ kind: 'shield', token: TOKEN, amount: 1 });
    expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
  });

  it('rejects a recipient that is not an address', () => {
    const batch = createBatchAccumulator();
    const result = batch.accept({ kind: 'transfer', token: TOKEN, amount: 1n, recipient: 'bob' });
    expect(!result.ok && result.rejection.reason).toBe('not-an-intent');
  });

  it('rejects a zero or negative amount', () => {
    const batch = createBatchAccumulator();
    expect(!batch.accept(shield(0n)).ok).toBe(true);
    expect(!batch.accept(shield(-1n)).ok).toBe(true);
  });

  it('bounds one visit at the minimum configured limit', () => {
    const batch = createBatchAccumulator({ maxIntents: 1 });
    expect(batch.accept(transfer(1n)).ok).toBe(true);
    const result = batch.accept(transfer(2n));
    expect(!result.ok && result.rejection.reason).toBe('batch-full');
    expect(!result.ok && result.rejection).toEqual({ reason: 'batch-full', limit: 1 });
  });

  it('accepts a reasonable configured maximum', () => {
    const batch = createBatchAccumulator({ maxIntents: 32 });
    for (let amount = 1n; amount <= 32n; amount += 1n) {
      expect(batch.accept(transfer(amount)).ok).toBe(true);
    }

    const result = batch.accept(transfer(33n));
    expect(!result.ok && result.rejection).toEqual({ reason: 'batch-full', limit: 32 });
  });

  it.each([
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid maximum intent bound', (maxIntents) => {
    expect(() => createBatchAccumulator({ maxIntents })).toThrowError(
      'maxIntents must be a positive safe integer',
    );
  });

  it('refuses to confirm nothing', () => {
    const batch = createBatchAccumulator();
    const result = batch.confirm();
    expect(!result.ok && result.rejection.reason).toBe('empty-batch');
  });

  it('keeps the visit intact after confirm so a failed prepare can be retried', () => {
    const batch = createBatchAccumulator();
    batch.accept(transfer());
    batch.confirm();
    expect(batch.intents).toHaveLength(1);
  });

  it('hands out a frozen snapshot rather than its own array', () => {
    const batch = createBatchAccumulator();
    const added = batch.accept(transfer());
    const snapshot = added.ok ? added.value : [];
    expect(Object.isFrozen(snapshot)).toBe(true);

    batch.accept(transfer(9n));
    expect(snapshot).toHaveLength(1);
  });

  it('removes and clears', () => {
    const batch = createBatchAccumulator();
    batch.accept(transfer(1n));
    batch.accept(transfer(2n));
    expect(batch.remove(0)).toHaveLength(1);
    batch.clear();
    expect(batch.intents).toHaveLength(0);
  });

  it('allows a shield batch again once the visit is cleared', () => {
    const batch = createBatchAccumulator();
    batch.accept(transfer());
    batch.clear();
    expect(batch.accept(shield()).ok).toBe(true);
  });
});
