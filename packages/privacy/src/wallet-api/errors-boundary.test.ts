import { describe, expect, it } from 'vitest';
import { mapWalletError } from './errors.js';

describe('wallet error boundary', () => {
  it('contains a prototype trap while mapping a hostile wallet failure', () => {
    const error = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('wallet error prototype must not escape');
      },
    });

    expect(() => mapWalletError(error)).not.toThrow();
    expect(mapWalletError(error)).toMatchObject({
      kind: 'unreachable',
      message: 'The wallet or network could not be reached.',
    });
  });
});
