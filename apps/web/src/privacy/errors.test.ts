import { describe, expect, it } from 'vitest';
import { PrivacyError, SwapPriceGuardError } from '@strkworld/privacy';
import { toFailure } from './errors.js';

describe('failure classification', () => {
  it('reads the kind off a seam error without importing its class at runtime', () => {
    expect(toFailure(new PrivacyError('not-registered', 'error 118')).kind).toBe('not-registered');
    expect(toFailure(new PrivacyError('insufficient-balance', 'error 119')).kind).toBe(
      'insufficient-balance',
    );
    expect(toFailure(new PrivacyError('submission-uncertain', 'response lost')).kind).toBe(
      'submission-uncertain',
    );
    // D-070: a relay with no avnu key is its own class, never `unknown`.
    expect(toFailure(new PrivacyError('relay-not-configured', 'relay not configured')).kind).toBe(
      'relay-not-configured',
    );
    // D-074: a transfer recipient's 118 is its own class, never the account's.
    expect(toFailure(new PrivacyError('recipient-not-registered', 'error 118 on a transfer')).kind).toBe(
      'recipient-not-registered',
    );
  });

  it('classifies anything else as unknown and keeps the cause for logs', () => {
    const raw = new Error('RPC 500: upstream exploded');
    const failure = toFailure(raw);
    expect(failure.kind).toBe('unknown');
    expect(failure.cause).toBe(raw);
    expect(toFailure(null).kind).toBe('unknown');
    expect(toFailure('boom').kind).toBe('unknown');
    expect(toFailure({ kind: 'something-else' }).kind).toBe('unknown');
  });

  it('fails closed for accessor-backed and inherited kinds', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'kind', {
      configurable: true,
      get() {
        reads += 1;
        throw new Error('kind getter should not run');
      },
    });
    const inherited = Object.create({ kind: 'not-registered' });

    expect(toFailure(accessor).kind).toBe('unknown');
    expect(toFailure(inherited).kind).toBe('unknown');
    expect(reads).toBe(0);
  });

  /**
   * D-126: the swap's oracle guard used to throw `unknown`, which logged as
   * `kind=unknown` and gave the counter nothing to say. It now has its own
   * kind and carries the two figures the counter says it with.
   */
  it('classifies an oracle refusal as price-guard and reads its figures', () => {
    const refusal = new SwapPriceGuardError('refused', { shortfallBps: 396, boundBps: 300 });
    expect(toFailure(refusal)).toMatchObject({
      kind: 'price-guard',
      priceGuard: { shortfallBps: 396, boundBps: 300 },
    });
    // Handed on and classified again, the figures survive with the kind.
    expect(toFailure(toFailure(refusal))).toMatchObject({
      kind: 'price-guard',
      priceGuard: { shortfallBps: 396, boundBps: 300 },
    });
  });

  it('keeps the price-guard kind but drops figures it cannot trust', () => {
    // The kind without the figures: still a refusal, and the counter falls
    // back to the kind's own copy rather than inventing a percentage.
    expect(toFailure(new PrivacyError('price-guard', 'refused'))).toEqual({
      kind: 'price-guard',
      cause: expect.any(PrivacyError),
    });
    for (const figures of [
      { shortfallBps: 'lots', boundBps: 300 },
      { shortfallBps: 396, boundBps: null },
      { shortfallBps: -1, boundBps: 300 },
      { shortfallBps: 396.5, boundBps: 300 },
      { shortfallBps: 396, boundBps: 100_001 },
      { shortfallBps: 396 },
    ]) {
      const error = Object.assign(new PrivacyError('price-guard', 'refused'), figures);
      expect(toFailure(error), JSON.stringify(figures)).not.toHaveProperty('priceGuard');
      expect(toFailure(error).kind).toBe('price-guard');
    }
    // A throwing getter for a figure is not a figure, and must not escape.
    const hostile = Object.defineProperty(new PrivacyError('price-guard', 'refused'), 'shortfallBps', {
      get() { throw new Error('figure getter should not run'); },
    });
    expect(toFailure(hostile)).toMatchObject({ kind: 'price-guard' });
    expect(toFailure(hostile)).not.toHaveProperty('priceGuard');
  });

  it('is idempotent, because a failure is reclassified as it is handed on', () => {
    // A panel classifies, then the connect flow classifies the same failure
    // again on its way to a room. A second pass must not degrade it.
    const once = toFailure(new PrivacyError('unsupported-wallet', 'error 162'));
    expect(toFailure(once).kind).toBe('unsupported-wallet');
    expect(toFailure(toFailure(once)).kind).toBe('unsupported-wallet');
  });
});
