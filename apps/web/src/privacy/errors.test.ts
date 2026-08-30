import { describe, expect, it } from 'vitest';
import { PrivacyError } from '@strkworld/privacy';
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

  it('is idempotent, because a failure is reclassified as it is handed on', () => {
    // A panel classifies, then the connect flow classifies the same failure
    // again on its way to a room. A second pass must not degrade it.
    const once = toFailure(new PrivacyError('unsupported-wallet', 'error 162'));
    expect(toFailure(once).kind).toBe('unsupported-wallet');
    expect(toFailure(toFailure(once)).kind).toBe('unsupported-wallet');
  });
});
