import { describe, expect, it } from 'vitest';
import { startPresenceServer } from './server';

describe('presence server options', () => {
  it('rejects a non-finite port-attempt count before binding', async () => {
    await expect(
      startPresenceServer({ port: 0, portAttempts: Number.NaN }),
    ).rejects.toThrow('Lobby port attempts must be a positive safe integer.');
  });

  it('rejects a non-finite base port before binding', async () => {
    await expect(
      startPresenceServer({ port: Number.NaN }),
    ).rejects.toThrow('Lobby base port must be an integer from 0 through 65535.');
  });
});
