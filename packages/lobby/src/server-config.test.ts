import { describe, expect, it } from 'vitest';
import { startPresenceServer } from './server';

describe('presence server options', () => {
  it('rejects a non-finite port-attempt count before binding', async () => {
    await expect(
      startPresenceServer({ port: 0, portAttempts: Number.NaN }),
    ).rejects.toThrow('Lobby port attempts must be a positive safe integer.');
  });
});
