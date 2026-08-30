import { describe, expect, it } from 'vitest';
import { createSupportedVersionsReader } from './discovery.js';

describe('supported-version discovery cancellation boundary', () => {
  it('contains a hostile cancellation getter before wallet discovery', async () => {
    const reader = createSupportedVersionsReader({} as never);
    const signal = new Proxy({}, {
      get() {
        throw new Error('cancellation getter must not escape');
      },
    }) as AbortSignal;

    await expect(reader(signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
