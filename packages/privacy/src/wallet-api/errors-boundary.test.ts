import { describe, expect, it } from 'vitest';
import { mapShadowWalletError, mapWalletError } from './errors.js';

function hostileWalletFailure(): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw new Error('wallet error prototype must not escape');
    },
  });
}

describe('wallet error boundary', () => {
  it('contains a prototype trap while mapping a hostile wallet failure', () => {
    const error = hostileWalletFailure();

    expect(() => mapWalletError(error)).not.toThrow();
    expect(mapWalletError(error)).toMatchObject({
      kind: 'unreachable',
      message: 'The wallet or network could not be reached.',
    });
  });

  it('contains the same trap on the shadow-account path (D-077)', () => {
    const error = hostileWalletFailure();

    expect(() => mapShadowWalletError(error)).not.toThrow();
    expect(mapShadowWalletError(error)).toMatchObject({
      kind: 'unreachable',
      message: 'The wallet or network could not be reached.',
    });
  });
});
